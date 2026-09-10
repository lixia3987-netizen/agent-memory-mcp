import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,readdirSync } from 'node:fs';
import path from 'node:path';
import { temporary,application } from '../helpers.ts';
import { migrations,SCHEMA_VERSION } from '../../src/infra/sqlite/migrations.ts';
import { resolveConfig } from '../../src/app/config.ts';
import { SqliteMemoryRepository } from '../../src/infra/sqlite/memory-repository.ts';
import { MemoryService } from '../../src/services/memory-service.ts';
import { bootstrap } from '../../src/app/bootstrap.ts';
import { TestLlm } from '../fixtures/providers.ts';

test('phase 1 schema v3 upgrades with original memory preserved and a v3 backup',async t=>{
  const home=temporary(t);const config=resolveConfig({homeDir:home,namespace:'test'});mkdirSync(path.dirname(config.dbPath),{recursive:true});
  const db=new DatabaseSync(config.dbPath);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  for(const migration of migrations.filter(m=>m.version<=3)){db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.name,Date.now());}
  const oldService=new MemoryService(new SqliteMemoryRepository(db,config),config);
  const old=oldService.add({content:'Existing phase one memory',metadata:{keep:['all','data']},importance:8}).memory;db.close();
  const app=await bootstrap({homeDir:home,namespace:'test'});
  try{
    const {expired:_expired,...current}=app.memory.get({id:old.id});assert.deepEqual(current,old);assert.equal(app.doctor().schemaVersion,SCHEMA_VERSION);
    const backup=readdirSync(path.join(home,'backup')).find(name=>name.startsWith('pre-migration-v3'));assert.ok(backup);
    const snapshot=new DatabaseSync(path.join(home,'backup',backup),{readOnly:true});
    try{assert.equal(snapshot.prepare('SELECT max(version) v FROM schema_migrations').get()!.v,3);assert.equal(snapshot.prepare('SELECT content FROM memories WHERE id=?').get(old.id)!.content,old.content);}finally{snapshot.close();}
  }finally{app.close();}
});
test('queued enrichment survives process restart and resumes against the same DB',async t=>{
  const app=await application(t);const memory=app.memory.add({content:'Project uses SQLite'}).memory;
  await app.enrichment.run({id:memory.id,action:'enqueue'});app.close();
  const reopened=await bootstrap({homeDir:app.config.homeDir,namespace:'test'}, {llm:new TestLlm()});
  try{assert.equal(reopened.maintenance.stats({}).pending_jobs,1);assert.equal((await reopened.enrichment.work(reopened.memory.scope({}),10)).completed,1);assert.equal(reopened.maintenance.stats({}).enrichments,1);}finally{reopened.close();}
});
test('schema 104 upgrades with a covering stats index, unchanged records and a schema 104 backup',async t=>{
  const home=temporary(t);const config=resolveConfig({homeDir:home,namespace:'test'});mkdirSync(path.dirname(config.dbPath),{recursive:true});
  const db=new DatabaseSync(config.dbPath);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  for(const migration of migrations.filter(m=>m.version<=104)){db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version,migration.name,Date.now());}
  const oldService=new MemoryService(new SqliteMemoryRepository(db,config),config);
  const old=oldService.add({content:'Existing phase one memory',metadata:{keep:['all','data']},importance:8}).memory;db.close();
  const app=await bootstrap({homeDir:home,namespace:'test'});
  try{
    const {expired:_expired,...current}=app.memory.get({id:old.id});assert.deepEqual(current,old);assert.equal(app.doctor().schemaVersion,SCHEMA_VERSION);
    const currentDb = new DatabaseSync(config.dbPath, { readOnly: true });
    try { assert.ok(currentDb.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_memory_stats'").get()); } finally { currentDb.close(); }
    const backup=readdirSync(path.join(home,'backup')).find(name=>name.startsWith('pre-migration-v104'));assert.ok(backup);
    const snapshot=new DatabaseSync(path.join(home,'backup',backup),{readOnly:true});
    try{assert.equal(snapshot.prepare('SELECT max(version) v FROM schema_migrations').get()!.v,104);assert.equal(snapshot.prepare('SELECT content FROM memories WHERE id=?').get(old.id)!.content,old.content);}finally{snapshot.close();}
  }finally{app.close();}
});
