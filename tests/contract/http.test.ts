import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cleanup, application } from '../helpers.ts';
import { serveHttp } from '../../src/mcp/http.ts';
import { request } from 'node:http';

test('HTTP is explicit, loopback-only and requires a configured token',async t=>{
  const app=await application(t);await assert.rejects(()=>serveHttp(app),/explicit/);
  await assert.rejects(()=>application(t,{http:{enabled:true,host:'0.0.0.0' as '127.0.0.1'}}));
  const enabled=await application(t,{http:{enabled:true,port:0,tokenEnv:'MISSING_MEMORY_TEST_TOKEN'}});
  await assert.rejects(()=>serveHttp(enabled),/bearer token/);
});
test('real MCP HTTP client works and rejects unauthorized, invalid-host and cross-origin requests',async t=>{
  const previous=process.env.MEMORY_HTTP_TEST_TOKEN;const token='local-test-token-abcdefghijklmnopqrstuvwxyz';process.env.MEMORY_HTTP_TEST_TOKEN=token;
  cleanup(t, ()=>{if(previous===undefined)delete process.env.MEMORY_HTTP_TEST_TOKEN;else process.env.MEMORY_HTTP_TEST_TOKEN=previous;});
  const app=await application(t,{http:{enabled:true,port:0,tokenEnv:'MEMORY_HTTP_TEST_TOKEN',maxRequestBytes:4096}});
  const listener=await serveHttp(app);cleanup(t, ()=>listener.close());
  assert.equal((await fetch(listener.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(listener.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Origin:'https://untrusted.example'},body:'{}'})).status,403);
  const forgedHost=await new Promise<number>((resolve,reject)=>{
    const req=request(listener.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end('{}');
  });
  assert.equal(forgedHost,403);
  assert.equal((await fetch(listener.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'x'.repeat(5000)})).status,413);
  const client=new Client({name:'http-contract',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));cleanup(t, ()=>client.close());
  assert.equal((await client.listTools()).tools.length,27);
  const added=await client.callTool({name:'memory_add',arguments:{content:'HTTP persistent memory'}});assert.ok(!added.isError);
  const found=await client.callTool({name:'memory_search',arguments:{query:'HTTP'}});assert.ok(!found.isError);
  assert.equal(((found.structuredContent as {memories:unknown[]}).memories).length,1);
});

test('HTTP receive deadline does not terminate an already received long-running MCP tool call',async t=>{
  const tokenEnv='MEMORY_HTTP_LONG_TEST_TOKEN';const previous=process.env[tokenEnv];
  const token='long-task-token-abcdefghijklmnopqrstuvwxyz';process.env[tokenEnv]=token;
  cleanup(t, ()=>{if(previous===undefined)delete process.env[tokenEnv];else process.env[tokenEnv]=previous;});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let started!:()=>void;const executing=new Promise<void>(resolve=>{started=resolve;});
  const provider={id:'slow-test',model:'slow',dimensions:()=>2,embed:async(texts:string[])=>{
    started();await gate;return texts.map(()=>[1,0]);
  }};
  const app=await application(t,{http:{enabled:true,port:0,tokenEnv,requestTimeoutMs:50,headersTimeoutMs:50}}, {embedding:provider});
  app.memory.add({content:'long task memory'});
  const listener=await serveHttp(app);cleanup(t, ()=>listener.close());
  assert.equal(listener.server.requestTimeout,50);assert.equal(listener.server.headersTimeout,50);
  const client=new Client({name:'long-http-contract',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  cleanup(t, ()=>client.close());
  const pending=client.callTool({name:'memory_reindex',arguments:{}});
  await executing;
  await new Promise<void>(resolve=>setTimeout(resolve,100));
  release();
  const result=await pending;assert.ok(!result.isError);
  assert.equal((result.structuredContent as {indexed:number}).indexed,1);
});
