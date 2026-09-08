import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { TestEmbedding,TestLlm } from '../fixtures/providers.ts';
import { AppError } from '../../src/shared/errors.ts';

test('disabled providers retain lexical service and perform no enrichment writes',async t=>{
  const app=await application(t);const m=app.memory.add({content:'SQLite local storage'}).memory;
  const result=await app.hybrid.search({query:'SQLite'});assert.equal(result.mode,'lexical');assert.equal(result.memories.length,1);
  assert.equal((await app.embeddings.rebuild({})).enabled,false);
  assert.equal((await app.enrichment.run({id:m.id})).status,'disabled');assert.equal(app.maintenance.stats({}).enrichments,0);
});
test('semantic matches beyond lexical text and respects all scope/TTL/deletion filters',async t=>{
  const provider=new TestEmbedding();const app=await application(t,{}, {embedding:provider});
  const car=app.memory.add({content:'A car has four wheels',tags:['transport']}).memory;
  app.memory.add({content:'A banana is a fruit'});
  const secret=app.memory.add({content:'vehicle belongs to another project',project:'private'}).memory;
  await app.embeddings.rebuild({});await app.embeddings.rebuild({project:'private'});
  assert.equal(app.memory.search({query:'automobile'}).memories.length,0);
  const semantic=await app.hybrid.search({query:'automobile',mode:'semantic',tags:['transport']});assert.equal(semantic.memories[0]?.id,car.id);
  assert.ok(!semantic.memories.some(m=>m.id===secret.id));
  assert.equal((await app.hybrid.search({query:'automobile',mode:'semantic',all_projects:true})).memories.length,2);
  app.memory.delete({id:car.id});assert.equal((await app.hybrid.search({query:'automobile',mode:'semantic'})).memories.length,0);
});
test('embedding updates use optimistic content hashes and stale work never overwrites current memory',async t=>{
  const provider=new TestEmbedding();const app=await application(t,{}, {embedding:provider});const m=app.memory.add({content:'old car content'}).memory;
  provider.beforeReturn=()=>{app.memory.update({id:m.id,updates:{content:'new fruit content'}});provider.beforeReturn=undefined;};
  assert.equal((await app.embeddings.rebuild({})).stale,1);assert.equal(app.maintenance.stats({}).embeddings,0);
  await app.embeddings.rebuild({});assert.equal(app.maintenance.stats({}).embeddings,1);
  app.memory.update({id:m.id,updates:{content:'different car content'}});assert.equal(app.maintenance.stats({}).embeddings,0);
});
test('forced embedding rebuild supports bounded continuation without repeating the first batch',async t=>{
  const app=await application(t,{}, {embedding:new TestEmbedding()});
  for(let i=0;i<5;i++)app.memory.add({content:`car knowledge ${i}`});
  const first=await app.embeddings.rebuild({limit:2,force:true});assert.ok(first.next_cursor);
  const second=await app.embeddings.rebuild({limit:2,force:true,after_id:first.next_cursor});assert.ok(second.next_cursor);
  const third=await app.embeddings.rebuild({limit:2,force:true,after_id:second.next_cursor});assert.equal(third.next_cursor,null);
  assert.equal(app.maintenance.stats({}).embeddings,5);
});
test('invalid vector batches fail atomically and provider failure falls back to lexical',async t=>{
  const provider=new TestEmbedding();const app=await application(t,{}, {embedding:provider});app.memory.add({content:'car'});app.memory.add({content:'fruit'});
  provider.embed=async()=>[[1,0,0],[0,0]];
  await assert.rejects(()=>app.embeddings.rebuild({}),/invalid dimensions/);assert.equal(app.maintenance.stats({}).embeddings,0);
  provider.embed=async texts=>texts.map(()=>[1,0,0]);await app.embeddings.rebuild({});
  provider.embed=async()=>{throw new AppError('PROVIDER_UNAVAILABLE','test outage');};
  const result=await app.hybrid.search({query:'car'});assert.equal(result.mode,'lexical');assert.equal(result.memories.length,1);
});
test('hybrid RRF adds graph-linked context and keeps graph memory filtering',async t=>{
  const app=await application(t,{}, {embedding:new TestEmbedding()});
  app.memory.add({content:'car wheels'});const graphMemory=app.memory.add({content:'Use a charging station',source:'manual'}).memory;
  const entity=app.graph.entityAdd({name:'automobile',aliases:['vehicle']}).entity;app.graph.link({memory_id:graphMemory.id,entity_id:entity.id});
  await app.embeddings.rebuild({});
  const result=await app.hybrid.search({query:'automobile'});assert.equal(result.mode,'hybrid');assert.ok(result.memories.some(m=>m.id===graphMemory.id));
  assert.equal((await app.hybrid.search({query:'automobile',source:'absent'})).memories.length,0);
});
test('duplicate proposals are non-destructive; confirmed merge retains snapshots and rejects stale confirmation',async t=>{
  const app=await application(t);const a=app.memory.add({content:'Use SQLite WAL for local durable memories.',source:'one'}).memory;
  const b=app.memory.add({content:'Use SQLite WAL for local durable memory.',source:'two'}).memory;
  assert.equal(app.duplicates.find({id:a.id,threshold:.5}).candidates[0]?.id,b.id);assert.equal(app.memory.list({}).total,2);
  const args={target_id:a.id,source_ids:[b.id]};const preview=app.duplicates.merge(args);
  assert.equal(preview.dry_run,true);assert.equal(app.memory.list({}).total,2);
  app.memory.update({id:b.id,updates:{importance:9}});
  assert.throws(()=>app.duplicates.merge({...args,dry_run:false,proposal_token:preview.proposal_token}),/stale/);
  const current=app.duplicates.merge(args);app.duplicates.merge({...args,dry_run:false,proposal_token:current.proposal_token});
  assert.equal(app.memory.list({}).total,1);assert.equal(app.memory.get({id:b.id,include_deleted:true}).source,'two');
  assert.ok(app.memory.get({id:a.id}).metadata?.merge_sources);
});
test('LLM enrichment stores validated suggestions, applies graph explicitly and leaves original memory unchanged',async t=>{
  const provider=new TestLlm();const app=await application(t,{}, {llm:provider});const m=app.memory.add({content:'Project uses SQLite.',type:'note',importance:5}).memory;
  await app.enrichment.run({id:m.id});assert.equal(app.maintenance.stats({}).entities,0);assert.equal(app.maintenance.stats({}).enrichments,1);
  await app.enrichment.run({id:m.id,action:'apply'});assert.equal(app.maintenance.stats({}).entities,2);assert.equal(app.maintenance.stats({}).relations,1);
  await app.enrichment.run({id:m.id,action:'apply'});assert.equal(app.maintenance.stats({}).relations,1);
  const {expired:_expired,...after}=app.memory.get({id:m.id});assert.deepEqual(after,m);
  await app.enrichment.run({id:m.id});assert.equal(provider.calls,1);
});
test('invalid and stale LLM results cannot replace raw memory or create graph records',async t=>{
  const provider=new TestLlm();const app=await application(t,{}, {llm:provider});const m=app.memory.add({content:'Project stores memory'}).memory;
  provider.result={summary:4};await assert.rejects(()=>app.enrichment.run({id:m.id}));assert.equal(app.memory.get({id:m.id}).content,m.content);
  provider.result={summary:'safe',entities:[],relations:[],tags:[],conflicts:[]};provider.beforeReturn=()=>{app.memory.update({id:m.id,updates:{content:'updated while provider works'}});provider.beforeReturn=undefined;};
  await assert.rejects(()=>app.enrichment.run({id:m.id}),/lease|changed/);assert.equal(app.maintenance.stats({}).enrichments,0);assert.equal(app.maintenance.stats({}).entities,0);
});
test('enrichment jobs persist and leases prevent two workers from claiming one job',async t=>{
  const app=await application(t,{}, {llm:new TestLlm()});const m=app.memory.add({content:'Project uses SQLite'}).memory;
  await app.enrichment.run({id:m.id,action:'enqueue'});assert.equal(app.maintenance.stats({}).pending_jobs,1);
  const claimed=app.intelligence.claimJob(app.memory.scope({}),10000)!;assert.ok(claimed);
  assert.equal(app.intelligence.claimJob(app.memory.scope({}),10000),null);
  app.intelligence.finishJob(claimed.id,'wrong-token','completed');assert.equal(app.maintenance.stats({}).pending_jobs,1);
  app.intelligence.finishJob(claimed.id,claimed.lease_token!,'failed');await app.enrichment.run({id:m.id,action:'enqueue'});
  const result=await app.enrichment.work(app.memory.scope({}),10);assert.equal(result.completed,1);
});
