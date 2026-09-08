import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { asAppError } from '../../src/shared/errors.ts';

test('entity aliases, identity dedupe, deletion/restore and all graph access stay scoped',async t=>{
  const app=await application(t);const a=app.graph.entityAdd({ name:'SQLite',type:'Technology',aliases:['sqlite3','本地数据库'] }).entity;
  assert.equal(app.graph.entityAdd({ name:' SQLITE ',type:'Technology' }).entity.id,a.id);
  assert.equal(app.graph.entitySearch({ query:'本地' }).entities[0]?.id,a.id);
  assert.throws(()=>app.graph.entityGet({id:a.id,project:'other'}),/not found/);
  const other=app.graph.entityAdd({name:'Other',project:'other'}).entity;
  assert.throws(()=>app.graph.relationAdd({source_entity_id:a.id,predicate:'USES',target_entity_id:other.id}),/not found/);
  app.graph.entityUpdate({id:a.id,updates:{deleted:true}});assert.equal(app.graph.entitySearch({query:'sqlite3'}).entities.length,0);
  app.graph.entityUpdate({id:a.id,updates:{deleted:false}});assert.equal(app.graph.entityGet({id:a.id}).name,'SQLite');
});
test('temporal supersession retains old history and obeys exact interval boundaries',async t=>{
  const app=await application(t);const project=app.graph.entityAdd({name:'Project',type:'Project'}).entity;
  const yjs=app.graph.entityAdd({name:'Yjs'}).entity,ot=app.graph.entityAdd({name:'OT'}).entity;
  const first=app.graph.relationAdd({source_entity_id:project.id,predicate:'USES',target_entity_id:yjs.id,valid_from:'2026-01-01T00:00:00Z'}).relation;
  const next=app.graph.relationAdd({source_entity_id:project.id,predicate:'USES',target_entity_id:ot.id,valid_from:'2026-07-01T00:00:00Z',conflict_strategy:'supersede',supersedes:first.id}).relation;
  assert.equal(app.graph.atTime({at:'2026-06-30T23:59:59Z'}).relations[0]?.id,first.id);
  assert.equal(app.graph.atTime({at:'2026-07-01T00:00:00Z'}).relations[0]?.id,next.id);
  assert.equal(app.graph.relationSearch({history:true}).relations.length,2);
  assert.equal(app.graph.relationSearch({history:true}).relations.find(r=>r.id===first.id)?.superseded_by,next.id);
  assert.throws(()=>app.graph.relationUpdate({id:first.id,updates:{valid_to:null}}),/cannot be reopened/);
  assert.throws(()=>app.graph.relationAdd({source_entity_id:project.id,predicate:'USES',target_entity_id:yjs.id,valid_from:'2026-07-01T00:00:00Z',conflict_strategy:'supersede',supersedes:next.id}),/strictly inside/);
  assert.equal(app.graph.relationSearch({history:true}).relations.length,2);
});
test('future supersession does not prematurely hide the presently valid fact',async t=>{
  const app=await application(t);const a=app.graph.entityAdd({name:'Project'}).entity,b=app.graph.entityAdd({name:'Old'}).entity,c=app.graph.entityAdd({name:'Future'}).entity;
  const old=app.graph.relationAdd({source_entity_id:a.id,predicate:'PRIMARY',target_entity_id:b.id,valid_from:'2020-01-01T00:00:00Z'}).relation;
  app.graph.relationAdd({source_entity_id:a.id,predicate:'PRIMARY',target_entity_id:c.id,valid_from:'2099-01-01T00:00:00Z',conflict_strategy:'supersede',supersedes:old.id});
  assert.equal(app.graph.relationSearch({}).relations[0]?.id,old.id);
});
test('historical fact queries preserve superseded facts after the source memory is edited',async t=>{
  const app=await application(t);const m=app.memory.add({content:'Project uses Old'}).memory;
  const a=app.graph.entityAdd({name:'Project'}).entity,b=app.graph.entityAdd({name:'Old'}).entity,c=app.graph.entityAdd({name:'New'}).entity;
  const old=app.graph.relationAdd({source_entity_id:a.id,predicate:'USES',target_entity_id:b.id,source_memory_id:m.id,valid_from:'2020-01-01T00:00:00Z'}).relation;
  app.memory.update({id:m.id,updates:{content:'Project uses New'}});
  const fresh=app.graph.relationAdd({source_entity_id:a.id,predicate:'USES',target_entity_id:c.id,source_memory_id:m.id,valid_from:'2022-01-01T00:00:00Z',conflict_strategy:'supersede',supersedes:old.id}).relation;
  assert.equal(app.graph.atTime({at:'2021-01-01T00:00:00Z'}).relations[0]?.id,old.id);
  assert.equal(app.graph.atTime({at:'2022-01-01T00:00:00Z'}).relations[0]?.id,fresh.id);
  assert.equal(app.graph.neighbors({entity_id:a.id,at:'2021-01-01T00:00:00Z'}).relations[0]?.id,old.id);
  assert.equal(app.graph.relationSearch({}).relations[0]?.id,fresh.id);
});
test('ambiguous alternatives are retained and marked; explicit parallel facts coexist',async t=>{
  const app=await application(t);const a=app.graph.entityAdd({name:'Project'}).entity,b=app.graph.entityAdd({name:'A'}).entity,c=app.graph.entityAdd({name:'B'}).entity;
  app.graph.relationAdd({source_entity_id:a.id,predicate:'PRIMARY',target_entity_id:b.id,valid_from:'2020-01-01T00:00:00Z'});
  const conflict=app.graph.relationAdd({source_entity_id:a.id,predicate:'PRIMARY',target_entity_id:c.id,valid_from:'2021-01-01T00:00:00Z'});
  assert.equal(conflict.conflicts.length,1);assert.equal(conflict.relation.status,'conflict');
  assert.ok(app.graph.relationSearch({predicate:'PRIMARY'}).relations.every(r=>r.confidence<=.5 && r.status==='conflict'));
  app.graph.relationAdd({source_entity_id:a.id,predicate:'SUPPORTS',target_entity_id:b.id,valid_from:'2020-01-01T00:00:00Z',conflict_strategy:'parallel'});
  app.graph.relationAdd({source_entity_id:a.id,predicate:'SUPPORTS',target_entity_id:c.id,valid_from:'2020-01-01T00:00:00Z',conflict_strategy:'parallel'});
  assert.ok(app.graph.relationSearch({predicate:'SUPPORTS'}).relations.every(r=>r.status==='active' && r.confidence===1));
});
test('bounded traversal handles cycles, direction, truncation and scope',async t=>{
  const app=await application(t,{graph:{maxNodes:4,maxEdges:10,maxDepth:3}});
  const nodes=['A','B','C','D','E'].map(name=>app.graph.entityAdd({name}).entity);
  for (let i=0;i<4;i++) app.graph.relationAdd({source_entity_id:nodes[i]!.id,predicate:'NEXT',target_entity_id:nodes[i+1]!.id});
  app.graph.relationAdd({source_entity_id:nodes[2]!.id,predicate:'CYCLE',target_entity_id:nodes[0]!.id});
  const result=app.graph.neighbors({entity_id:nodes[0]!.id,max_depth:3,direction:'both'});assert.ok(result.entities.length<=4);assert.equal(result.truncated,true);
  assert.equal(app.graph.path({source_entity_id:nodes[0]!.id,target_entity_id:nodes[2]!.id,max_depth:2,direction:'out'}).found,true);
  assert.equal(app.graph.path({source_entity_id:nodes[4]!.id,target_entity_id:nodes[0]!.id,max_depth:3,direction:'out'}).found,false);
  assert.throws(()=>app.graph.neighbors({entity_id:nodes[0]!.id,max_depth:4}));
});
test('source changes hide stale facts and linked memories cannot silently move projects',async t=>{
  const app=await application(t);const m=app.memory.add({content:'Project uses SQLite'}).memory;
  const a=app.graph.entityAdd({name:'Project'}).entity,b=app.graph.entityAdd({name:'SQLite'}).entity;
  app.graph.link({memory_id:m.id,entity_id:a.id});
  app.graph.relationAdd({source_entity_id:a.id,predicate:'USES',target_entity_id:b.id,source_memory_id:m.id});
  assert.throws(()=>app.memory.update({id:m.id,updates:{project:'elsewhere'}}),error=>asAppError(error).code==='CONFLICT');
  app.memory.update({id:m.id,updates:{content:'Project uses another storage'}});
  assert.equal(app.graph.relationSearch({}).relations.length,0);
  assert.equal(app.graph.relationSearch({include_stale:true}).relations.length,1);
});
