import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Application } from '../app/bootstrap.ts';
import { createMcpServer } from './server.ts';
import { AppError } from '../shared/errors.ts';

export async function serveHttp(app: Application) {
  const config=app.config.http;
  if (!config.enabled) throw new AppError('VALIDATION_ERROR','HTTP transport requires explicit http.enabled:true.');
  const token=process.env[config.tokenEnv];
  if (!token || Buffer.byteLength(token)<32) throw new AppError('PERMISSION_DENIED','HTTP requires a bearer token of at least 32 bytes in the configured tokenEnv.');
  const expected=Buffer.from(`Bearer ${token}`);let active=0;let port=config.port;
  const server=createServer({ requestTimeout:config.requestTimeoutMs,headersTimeout:config.headersTimeoutMs },async(req,res)=>{
    const reject=(status:number,message:string)=>{ res.writeHead(status,{ 'Content-Type':'application/json','Cache-Control':'no-store' });res.end(JSON.stringify({ error:message })); };
    const host=config.host==='::1' ? '[::1]' : config.host;
    if (req.headers.host!==`${host}:${port}`) { reject(403,'Invalid Host');return; }
    if (req.headers.origin && req.headers.origin!==`http://${host}:${port}`) { reject(403,'Origin is not allowed');return; }
    const provided=Buffer.from(req.headers.authorization ?? '');
    if (provided.length!==expected.length || !timingSafeEqual(provided,expected)) { reject(401,'Bearer authentication required');return; }
    if (req.url!=='/mcp') { reject(404,'Not found');return; }
    if (req.method!=='POST') { res.setHeader('Allow','POST');reject(405,'Stateless MCP accepts POST only');return; }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { reject(415,'JSON content type required');return; }
    if (active>=config.maxConcurrentRequests) { reject(429,'Too many concurrent requests');return; }
    if (Number(req.headers['content-length'] ?? 0)>config.maxRequestBytes) { reject(413,'Request exceeds the byte limit');return; }
    active++;
    let mcp: ReturnType<typeof createMcpServer> | undefined;
    try {
      let size=0;const chunks: Buffer[]=[];
      for await (const chunk of req) { const bytes=Buffer.from(chunk as Uint8Array);size+=bytes.length;if (size>config.maxRequestBytes) { reject(413,'Request exceeds the byte limit');return; }chunks.push(bytes); }
      let body: unknown;try { body=JSON.parse(Buffer.concat(chunks).toString('utf8')); }catch { reject(400,'Invalid JSON');return; }
      mcp=createMcpServer(app);
      const transport=new StreamableHTTPServerTransport({ sessionIdGenerator:undefined,enableJsonResponse:true });
      res.once('close',()=>{ void mcp?.close(); });
      await mcp.connect(transport);await transport.handleRequest(req,res,body);
    } catch { if (!res.headersSent) reject(500,'MCP request failed');else if (!res.writableEnded) res.end(); }
    finally { active--;if (res.writableEnded) await mcp?.close(); }
  });
  // Receipt deadlines above do not limit tool execution after the body arrives.
  // Model calls have provider deadlines; MCP clients may impose their own deadline.
  await new Promise<void>((resolve,reject)=>{ server.once('error',reject);server.listen(config.port,config.host,()=>{ server.off('error',reject);resolve(); }); });
  const address=server.address();if (address && typeof address==='object') port=address.port;
  const host=config.host==='::1' ? '[::1]' : config.host;
  return { server,url:`http://${host}:${port}/mcp`,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())) };
}
