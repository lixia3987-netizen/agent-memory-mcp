import { cleanup } from '../helpers.ts';
import { createServer } from 'node:http';
import type { TestContext } from 'node:test';

type ProviderResponse = {status?:number;body?:unknown;hang?:boolean};
export async function providerServer(t:TestContext,handler:(route:string,body:Record<string,unknown>,authorization:string|undefined)=>ProviderResponse | Promise<ProviderResponse>) {
  const requests:{route:string;body:Record<string,unknown>;authorization:string|undefined}[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
    const route=req.url!;requests.push({route,body,authorization:req.headers.authorization});
    const result=await handler(route,body,req.headers.authorization);if(result.hang)return;
    res.writeHead(result.status ?? 200,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup(t, async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();if (!address || typeof address==='string') throw new Error('No address');
  return {baseUrl:`http://127.0.0.1:${address.port}/v1`,requests};
}
