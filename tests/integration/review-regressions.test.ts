import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { application } from '../helpers.ts';
import { TestEmbedding, TestLlm } from '../fixtures/providers.ts';
import { SqliteGraphRepository } from '../../src/infra/sqlite/graph-repository.ts';
import { SqliteMemoryRepository } from '../../src/infra/sqlite/memory-repository.ts';
import { MemoryService } from '../../src/services/memory-service.ts';
import { probeFts } from '../../src/infra/sqlite/database.ts';
import { resolveConfig } from '../../src/app/config.ts';

test('repository link/unlink/merge reject foreign endpoints and wrong scopes before mutation',async t=>{
  const app=await application(t);const scope=app.memory.scope({});
  const local=app.memory.add({content:'local target'}).memory;
  const source=app.memory.add({content:'local source'}).memory;
  const entity=app.graph.entityAdd({name:'local entity'}).entity;
  const targetEntity=app.graph.entityAdd({name:'local target entity'}).entity;
  app.graph.link({memory_id:source.id,entity_id:entity.id,role:'manual'});
  const fact=app.graph.relationAdd({source_entity_id:entity.id,target_entity_id:targetEntity.id,predicate:'USES',source_memory_id:source.id}).relation;
  const db=new DatabaseSync(app.config.dbPath);t.after(()=>db.close());
  const repo=new SqliteGraphRepository(db);
  const snapshot=()=>({links:db.prepare('SELECT * FROM memory_entities ORDER BY memory_id,entity_id,role').all(),relations:db.prepare('SELECT * FROM relations ORDER BY id').all()});
  for (const otherScope of [{namespace:'test',project:'other'},{namespace:'other',project:null}]) {
    const foreign=app.memory.add({...otherScope,content:'foreign source'}).memory;
    const foreignEntity=app.graph.entityAdd({...otherScope,name:'foreign entity'}).entity;
    const before=snapshot();
    assert.throws(()=>repo.link(local.id,foreignEntity.id,scope,'manual',1),/scope/);
    assert.throws(()=>repo.link(foreign.id,entity.id,scope,'manual',1),/scope/);
    assert.throws(()=>repo.link(source.id,entity.id,otherScope,'manual',1,true),/scope/);
    assert.throws(()=>repo.mergeLinks(local.id,foreign.id,local.content_hash,scope),/scope/);
    assert.throws(()=>repo.mergeLinks(local.id,source.id,local.content_hash,otherScope),/scope/);
    assert.deepEqual(snapshot(),before);
  }
  assert.throws(()=>repo.mergeLinks(local.id,source.id,'stale-hash',scope),/version/);
  app.memory.delete({id:source.id});
  repo.mergeLinks(local.id,source.id,local.content_hash,scope);
  assert.equal(db.prepare('SELECT source_memory_id FROM relations WHERE id=?').get(fact.id)!.source_memory_id,local.id);
  assert.ok(repo.links([entity.id],app.memory.filters({}),100).includes(local.id));
  repo.link(local.id,entity.id,scope,'manual',1,true);
  assert.ok(!repo.links([entity.id],app.memory.filters({}),100).includes(local.id));
});

test('markApplied requires scope, matching current version and an active memory',async t=>{
  const app=await application(t,{}, {llm:new TestLlm()});const scope=app.memory.scope({});
  const m=app.memory.add({content:'Project uses SQLite'}).memory;
  await app.enrichment.run({id:m.id});
  for (const wrongScope of [{namespace:'other',project:null},{namespace:'test',project:'other'}]) {
    assert.equal(app.intelligence.markApplied(m.id,m.content_hash,wrongScope),false);
  }
  assert.equal(app.intelligence.markApplied(m.id,'stale',scope),false);
  app.memory.delete({id:m.id});assert.equal(app.intelligence.markApplied(m.id,m.content_hash,scope),false);
  app.memory.restore({id:m.id});
  app.memory.update({id:m.id,updates:{expires_at:'2000-01-01T00:00:00Z'}});
  assert.equal(app.intelligence.markApplied(m.id,m.content_hash,scope),false);
  app.memory.update({id:m.id,updates:{expires_at:null}});
  assert.equal(app.intelligence.enrichment(m.id,scope)!.applied_at,null);
  assert.equal(app.intelligence.markApplied(m.id,m.content_hash,scope),true);
  assert.equal(app.intelligence.markApplied(m.id,m.content_hash,scope),false);
});

test('global ID collision checking prevents import overwrites across namespace/project',async t=>{
  const app=await application(t);
  const m=app.memory.add({content:'preserve original'}).memory;
  const data=app.exports.run({format:'json'}).data;
  for (const scope of [{namespace:'test',project:'other'},{namespace:'other',project:null}]) {
    await assert.rejects(()=>app.imports.run({...scope,format:'json',data,conflict:'update',dry_run:false}),/outside the target scope/);
    assert.equal(app.memory.list(scope).total,0);
    assert.equal((await app.imports.run({...scope,format:'json',data,conflict:'copy',dry_run:false})).copied,1);
    assert.notEqual(app.memory.list(scope).memories[0]!.id,m.id);
    assert.equal(app.memory.get({id:m.id}).content,m.content);
  }
});

test('import provenance does not resolve a memory that has moved outside its original scope',async t=>{
  const app=await application(t);
  const data=JSON.stringify({schemaVersion:1,exportedAt:new Date().toISOString(),memories:[{content:'import then move'}]});
  await app.imports.run({format:'json',data,dry_run:false});
  const original=app.memory.list({}).memories[0]!;
  app.memory.update({id:original.id,updates:{project:'other'}});
  const imported=await app.imports.run({format:'json',data,dry_run:false});
  assert.equal(imported.added,1);assert.equal(imported.skipped,0);
  assert.equal(app.memory.list({}).total,1);assert.equal(app.memory.list({project:'other'}).total,1);
  assert.notEqual(app.memory.list({}).memories[0]!.id,original.id);
});

test('service purge requires confirmation and only removes deleted memories in the selected scope',async t=>{
  const app=await application(t);
  const local=app.memory.add({content:'local deleted'}).memory;
  const foreign=app.memory.add({content:'foreign deleted',project:'other'}).memory;
  app.memory.add({content:'active memory'});
  app.memory.delete({id:local.id});app.memory.delete({id:foreign.id,project:'other'});
  const before='2100-01-01T00:00:00Z';
  assert.throws(()=>app.memory.purge({before}));
  assert.throws(()=>app.memory.purge({before:'invalid',confirmed:true}));
  assert.throws(()=>app.memory.purge({before,confirmed:true,all_projects:true,project:'other'}));
  assert.equal(app.memory.purge({before,confirmed:true}).purged,1);
  assert.equal(app.memory.list({include_deleted:true}).total,1);
  assert.equal(app.memory.get({id:foreign.id,project:'other',include_deleted:true}).id,foreign.id);
});

test('shared-connection nested transactions roll back independently across repository instances',async t=>{
  const app=await application(t);const db=new DatabaseSync(app.config.dbPath);t.after(()=>db.close());
  const first=new SqliteMemoryRepository(db,app.config);const second=new SqliteMemoryRepository(db,app.config);
  const a=new MemoryService(first,app.config);const b=new MemoryService(second,app.config);
  first.transaction(()=>{
    a.add({content:'outer kept'});
    assert.throws(()=>second.transaction(()=>{b.add({content:'nested discarded'});throw new Error('nested failure');}),/nested failure/);
    second.transaction(()=>b.add({content:'preview discarded'}),true);
    b.add({content:'outer also kept'});
  });
  assert.deepEqual(app.memory.list({}).memories.map(m=>m.content).sort(),['outer also kept','outer kept']);
  assert.throws(()=>first.transaction(()=>{second.transaction(()=>b.add({content:'outer rollback'}));throw new Error('abort outer');}),/abort outer/);
  assert.equal(app.memory.list({}).total,2);
});

test('transactions reject async callbacks before execution and roll back returned thenables',async t=>{
  const app=await application(t);let executed=false;
  assert.throws(()=>{
    // @ts-expect-error Async callbacks are also rejected by the public type contract.
    app.memory.repository.transaction(async()=>{executed=true;await Promise.resolve();app.memory.add({content:'escaped async write'});});
  },/synchronous/);
  // Deliberately simulate a JavaScript/untyped caller hiding its promise return.
  const unsafe:()=>unknown=()=>{app.memory.add({content:'synchronous prefix'});return Promise.reject(new Error('unobserved rejection'));};
  assert.throws(()=>app.memory.repository.transaction(unsafe),/promises or thenables/);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(executed,false);assert.equal(app.memory.list({}).total,0);
  app.memory.add({content:'connection remains usable'});assert.equal(app.memory.list({}).total,1);
});

test('FTS capability probes exercise tokenizers, report missing support and leave no temporary tables',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  assert.deepEqual(probeFts(db),{fts5:true,trigram:true});
  assert.equal(db.prepare('SELECT count(*) n FROM sqlite_temp_master').get()!.n,0);
  const mocked=t.mock.method(db,'exec',()=>{throw new Error('no such module: fts5');});
  assert.deepEqual(probeFts(db),{fts5:false,trigram:false});
  mocked.mock.restore();
  assert.deepEqual(probeFts(db),{fts5:true,trigram:true});
});

test('duplicate candidate bytes and vector budgets are independent and both report truncation',async t=>{
  const app=await application(t,{duplicates:{maxCandidateBytes:1024}}, {embedding:new TestEmbedding()});
  const m=app.memory.add({content:'car '+ 'a'.repeat(500)}).memory;
  app.memory.add({content:'car '+ 'b'.repeat(500)});app.memory.add({content:'car '+ 'c'.repeat(500)});
  await app.embeddings.rebuild({});
  const textLimited=app.duplicates.find({id:m.id,mode:'hybrid',threshold:0});
  assert.equal(textLimited.text_truncated,true);assert.equal(textLimited.vector_truncated,false);assert.equal(textLimited.truncated,true);
  const other=await application(t,{duplicates:{maxCandidateBytes:16384},embedding:{maxCandidates:1}}, {embedding:new TestEmbedding()});
  const target=other.memory.add({content:'car one'}).memory;other.memory.add({content:'car two'});
  await other.embeddings.rebuild({});
  const vectorLimited=other.duplicates.find({id:target.id,mode:'hybrid',threshold:0});
  assert.equal(vectorLimited.text_truncated,false);assert.equal(vectorLimited.vector_truncated,true);assert.equal(vectorLimited.truncated,true);
});

test('statistics keep scoped knowledge counts and explicitly identify global operational metrics',async t=>{
  const app=await application(t,{}, {embedding:new TestEmbedding()});
  app.memory.add({content:'car'});app.memory.add({content:'fruit',project:'other'});
  await app.embeddings.rebuild({});
  app.intelligence.recordGlobalToolMetrics('memory_add',10,false);
  app.intelligence.recordGlobalToolMetrics('memory_add',30,true);
  const local=app.intelligence.stats(app.memory.scope({}));const other=app.intelligence.stats(app.memory.scope({project:'other'}));
  assert.equal(local.embeddings,1);assert.equal(other.embeddings,0);
  assert.equal(local.metrics_scope,'whole_database');assert.equal(other.metrics_scope,'whole_database');
  assert.deepEqual(other.tool_metrics,local.tool_metrics);
  assert.deepEqual(local.tool_metrics,[{tool:'memory_add',calls:2,errors:1,average_ms:20,max_ms:30}]);
});

test('configuration rejects obsolete ranking names and inconsistent receive deadlines',()=>{
  assert.throws(()=>resolveConfig({search:{lexicalWeight:1} as never}),/lexicalWeight/);
  assert.throws(()=>resolveConfig({http:{requestTimeoutMs:100,headersTimeoutMs:200}}),/headersTimeoutMs/);
});
