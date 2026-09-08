import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { TestLlm } from '../fixtures/providers.ts';

test('policy enforces types/sources/namespace, importance, size, TTL and secret rejection across writes',async t=>{
  const app=await application(t,{policy:{rejectTypes:['shell-log'],rejectSources:['noisy'],rejectNamespaces:['blocked'],minimumImportance:5,maxContentBytes:512,
    typeDefaults:{decision:{importance:8},temporary:{ttlDays:7}}}});
  const decision=app.memory.add({content:'Use SQLite',type:'decision'}).memory;assert.equal(decision.importance,8);
  const temp=app.memory.add({content:'temporary constraint',type:'temporary'}).memory;assert.ok(Date.parse(temp.expires_at!)-Date.now()>6*86400000);
  for (const input of [{content:'x',type:'shell-log'},{content:'x',source:'noisy'},{content:'x',namespace:'blocked'},{content:'x',importance:2},{content:'x'.repeat(600)},{content:'password=abcdefghijk'}]) assert.throws(()=>app.memory.add(input));
  assert.throws(()=>app.memory.update({id:decision.id,updates:{metadata:{api_key:'abcdefghijklmnop'}}}),/Secret/);
  await assert.rejects(()=>app.imports.run({format:'markdown',data:'token note: password=abcdefghijkl',dry_run:false}),/Secret/);
});
test('redaction removes supported credentials from body and nested metadata',async t=>{
  const app=await application(t,{policy:{secretAction:'redact'}});
  const m=app.memory.add({content:'Configure password=abcdefghijk locally.',metadata:{nested:{password:'abcdefghijklmnop'}}}).memory;
  assert.ok(!m.content.includes('abcdefghijk'));assert.deepEqual(m.metadata,{nested:{password:'[REDACTED]'}});
});
test('maintenance previews expiration/orphans and explicitly rebuilds FTS without changing active content',async t=>{
  const app=await application(t);const expired=app.memory.add({content:'old setting',expires_at:'2000-01-01T00:00:00Z'}).memory;
  const live=app.memory.add({content:'live searchable SQLite'}).memory;const orphan=app.graph.entityAdd({name:'Orphan'}).entity;
  await app.maintenance.run({action:'expire'});assert.equal(app.memory.get({id:expired.id}).deleted_at,null);
  await app.maintenance.run({action:'expire',dry_run:false});assert.throws(()=>app.memory.get({id:expired.id}));
  await app.maintenance.run({action:'orphans',dry_run:false});assert.throws(()=>app.graph.entityGet({id:orphan.id}));
  await app.maintenance.run({action:'fts-rebuild',dry_run:false});assert.equal(app.memory.search({query:'SQLite'}).memories[0]?.id,live.id);
  await app.maintenance.run({action:'vacuum',dry_run:false});assert.equal(app.doctor().integrity,'ok');
});
test('enrichment links invalidate on content change and memory purge cannot resurrect sourced facts',async t=>{
  const app=await application(t,{}, {llm:new TestLlm()});const m=app.memory.add({content:'Project uses SQLite'}).memory;
  await app.enrichment.run({id:m.id});await app.enrichment.run({id:m.id,action:'apply'});
  const entity=app.graph.entitySearch({query:'SQLite'}).entities[0]!;
  assert.equal(app.graph.linkedMemoryIds([entity.id],app.memory.filters({}),100).length,1);
  app.memory.update({id:m.id,updates:{content:'Unrelated new content'}});
  assert.equal(app.graph.linkedMemoryIds([entity.id],app.memory.filters({}),100).length,0);
  app.memory.delete({id:m.id});app.memory.repository.purge(app.memory.filters({}),'2100-01-01T00:00:00Z');
  assert.equal(app.graph.relationSearch({}).relations.length,0);
  assert.equal(app.graph.relationSearch({include_deleted:true,include_stale:true}).relations.length,1);
});
test('custom importer registry detects versions, imports idempotently and rejects unknown adapters',async t=>{
  const app=await application(t);
  app.imports.register({id:'custom-json',version:1,extensions:['.custom'],detectVersion:file=>file.text.startsWith('v1:') ? '1' : null,
    parse:file=>[{file,key:'item',record:{content:file.text.slice(3),source:'custom-json'}}]});
  assert.equal(app.imports.listAdapters().length,4);
  assert.equal((await app.imports.run({format:'custom-json',data:'v1:durable custom note',dry_run:false})).added,1);
  assert.equal((await app.imports.run({format:'custom-json',data:'v1:durable custom note',dry_run:false})).skipped,1);
  await assert.rejects(()=>app.imports.run({format:'custom-json',data:'v2:unknown'}),/version/);
  await assert.rejects(()=>app.imports.run({format:'unregistered',data:'text'}),/not registered/);
});
