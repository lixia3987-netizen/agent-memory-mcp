import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanup, application } from '../helpers.ts';
import { providerServer } from '../fixtures/http-provider.ts';
import { ProviderHttpClient } from '../../src/infra/providers/http-client.ts';
import { OpenAICompatibleEmbeddingProvider } from '../../src/infra/providers/openai-compatible.ts';
import { resolveConfig } from '../../src/app/config.ts';

test('real HTTP embedding adapter sends configured requests and handles reordered vector indexes',async t=>{
  const endpoint=await providerServer(t,(_route,body)=>({body:{data:(body.input as string[]).map((_text,index)=>({index,embedding:index===0 ? [1,0] : [0,1]})).reverse()}}));
  const old=process.env.MEMORY_TEST_KEY;process.env.MEMORY_TEST_KEY='test-auth-value-not-persisted';cleanup(t, ()=>{if(old===undefined)delete process.env.MEMORY_TEST_KEY;else process.env.MEMORY_TEST_KEY=old;});
  const app=await application(t,{embedding:{enabled:true,baseUrl:endpoint.baseUrl,model:'embed-test',apiKeyEnv:'MEMORY_TEST_KEY',retries:0}});
  app.memory.add({content:'alpha'});app.memory.add({content:'beta'});
  assert.equal((await app.embeddings.rebuild({})).indexed,2);assert.equal(endpoint.requests[0]?.route,'/v1/embeddings');
  assert.equal(endpoint.requests[0]?.authorization,'Bearer test-auth-value-not-persisted');
  assert.equal(app.embeddings.provider?.dimensions(),2);
  assert.ok(!readFileSync(app.config.dbPath).includes('test-auth-value-not-persisted'));
});

test('non-retryable HTTP errors neither retry nor trip the provider circuit',async t=>{
  let status=401;
  const endpoint=await providerServer(t,()=>({status,body:{ok:true}}));
  const client=new ProviderHttpClient(resolveConfig({llm:{enabled:true,baseUrl:endpoint.baseUrl,model:'test',retries:2,circuitFailures:1}}).llm);
  for (const code of [401,400,422]) {
    status=code;
    await assert.rejects(()=>client.post('test',{}),new RegExp(`HTTP ${code}`));
  }
  assert.equal(endpoint.requests.length,3);
  status=200;assert.deepEqual(await client.post('test',{}),{ok:true});
  assert.equal(endpoint.requests.length,4);
});

test('caller cancellation does not open the circuit for the next provider request',async t=>{
  const controller=new AbortController();let calls=0;
  const endpoint=await providerServer(t,()=>{
    if (++calls===1) {controller.abort();return {hang:true};}
    return {body:{ok:true}};
  });
  const client=new ProviderHttpClient(resolveConfig({llm:{enabled:true,baseUrl:endpoint.baseUrl,model:'test',retries:0,circuitFailures:1}}).llm);
  await assert.rejects(()=>client.post('test',{},controller.signal));
  assert.deepEqual(await client.post('test',{}),{ok:true});
  assert.equal(calls,2);
});

test('concurrent embedding responses lock the first validated dimension without overwriting it',async t=>{
  for (const [slowDimension,fastDimension] of [[3,2],[2,3]] as const) {
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let arrived!:()=>void;const slowArrived=new Promise<void>(resolve=>{arrived=resolve;});
    const endpoint=await providerServer(t,async(_route,body)=>{
      const slow=(body.input as string[])[0]==='slow';
      if (slow) {arrived();await gate;}
      return {body:{data:[{index:0,embedding:Array.from({length:slow ? slowDimension : fastDimension},()=>1)}]}};
    });
    const provider=new OpenAICompatibleEmbeddingProvider(resolveConfig({embedding:{enabled:true,baseUrl:endpoint.baseUrl,model:'test',retries:0}}).embedding);
    const slow=provider.embed(['slow']);
    const rejected=assert.rejects(slow,/invalid dimensions/);
    await slowArrived;
    try { assert.equal((await provider.embed(['fast']))[0]!.length,fastDimension); }
    finally { release(); }
    await rejected;assert.equal(provider.dimensions(),fastDimension);
    assert.equal((await provider.embed(['fast']))[0]!.length,fastDimension);
  }
});
test('HTTP provider retries transient errors, enforces timeout and opens a circuit',async t=>{
  let count=0;const endpoint=await providerServer(t,()=>++count===1 ? {status:503,body:{error:'unavailable'}} : {body:{data:[{index:0,embedding:[1,0]}]}});
  const app=await application(t,{embedding:{enabled:true,baseUrl:endpoint.baseUrl,model:'test',retries:1,circuitFailures:1,circuitCooldownMs:1000}});
  app.memory.add({content:'one'});assert.equal((await app.embeddings.rebuild({})).indexed,1);assert.equal(count,2);
  const hanging=await providerServer(t,()=>({hang:true}));
  const timeoutApp=await application(t,{embedding:{enabled:true,baseUrl:hanging.baseUrl,model:'test',timeoutMs:50,retries:0,circuitFailures:1,circuitCooldownMs:1000}});
  timeoutApp.memory.add({content:'one'});
  await assert.rejects(()=>timeoutApp.embeddings.rebuild({}),/failed or timed out/);
  await assert.rejects(()=>timeoutApp.embeddings.rebuild({}),/circuit/);assert.equal(hanging.requests.length,1);
});
test('LLM HTTP adapter validates JSON and never overwrites original content on malformed responses',async t=>{
  let invalid=false;const endpoint=await providerServer(t,()=>({body:{choices:[{message:{content:invalid ? '{invalid' : JSON.stringify({summary:'Summary',tags:['test'],entities:[],relations:[],conflicts:[]})}}]}}));
  const app=await application(t,{llm:{enabled:true,baseUrl:endpoint.baseUrl,model:'chat-test',retries:0}});
  const first=app.memory.add({content:'First original memory'}).memory;await app.enrichment.run({id:first.id});
  assert.equal(endpoint.requests[0]?.route,'/v1/chat/completions');assert.equal(app.memory.get({id:first.id}).content,'First original memory');
  invalid=true;const second=app.memory.add({content:'Second original memory'}).memory;
  await assert.rejects(()=>app.enrichment.run({id:second.id}),/schema validation/);
  assert.equal(app.memory.get({id:second.id}).content,'Second original memory');
});
