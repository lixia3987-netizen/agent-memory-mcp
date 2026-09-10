import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { asAppError } from '../../src/shared/errors.ts';

const created_at = '2099-01-01T00:00:00.000Z';
const updated_at = '2099-01-02T00:00:00.000Z';
const document = (memories: unknown[]) => JSON.stringify({ schemaVersion:1,exportedAt:new Date().toISOString(),memories });

test('normal edits, delete and restore preserve imported clock chronology and actual deletion time', async t => {
  const app = await application(t);
  await app.imports.run({ format:'json',data:document([{ id:'future',content:'Original future-clock note',created_at,updated_at }]),dry_run:false });
  const edited = app.memory.update({ id:'future',updates:{ content:'Edited future-clock note',importance:7 } });
  assert.equal(edited.created_at, created_at);
  assert.ok(edited.updated_at >= updated_at);
  const before = Date.now(); const removed = app.memory.delete({ id:'future' }); const after = Date.now();
  assert.ok(Date.parse(removed.deleted_at) >= before && Date.parse(removed.deleted_at) <= after);
  assert.ok(app.memory.get({ id:'future',include_deleted:true }).updated_at >= edited.updated_at);
  const restored = app.memory.restore({ id:'future' });
  assert.equal(restored.deleted_at, null); assert.ok(restored.updated_at >= edited.updated_at);
  assert.equal(app.memory.search({ query:'Edited' }).memories[0]?.id, 'future');
});

test('import updates without timestamps handle future clocks, while explicit reversed timestamps still roll back', async t => {
  const app = await application(t);
  const run = (records: unknown[],dry_run=false) => app.imports.run({ format:'json',data:document(records),conflict:'update',dry_run });
  await run([{ id:'future-import',content:'Original imported note',created_at,updated_at }]);
  assert.equal((await run([{ id:'future-import',content:'Changed imported note' }],true)).updated, 1);
  assert.equal(app.memory.get({ id:'future-import' }).content, 'Original imported note');
  await run([{ id:'future-import',content:'Changed imported note' }]);
  assert.ok(app.memory.get({ id:'future-import' }).updated_at >= updated_at);
  const later = '2099-01-03T00:00:00.000Z';
  await assert.rejects(() => run([{ id:'future-import',content:'Unpaired later creation',created_at:later }]),
    error => asAppError(error).code === 'VALIDATION_ERROR');
  await run([{ id:'future-import',content:'Later source creation',created_at:later,updated_at:later }]);
  const current = app.memory.get({ id:'future-import' }); assert.equal(current.created_at, later);
  assert.ok(current.updated_at >= later);
  await assert.rejects(() => run([{ id:'future-import',content:'Reject backwards time',updated_at:'2000-01-01T00:00:00.000Z' }]),
    error => asAppError(error).code === 'VALIDATION_ERROR');
  assert.deepEqual(app.memory.get({ id:'future-import' }), current);
});

test('confirmed merges preserve future target and source chronology through update and soft deletion', async t => {
  const app = await application(t);
  await app.imports.run({ format:'json',data:document([
    { id:'future-target',content:'Target knowledge',created_at,updated_at },
    { id:'future-source',content:'Source knowledge',created_at,updated_at },
  ]),dry_run:false });
  const input = { target_id:'future-target',source_ids:['future-source'] };
  const proposal = app.duplicates.merge(input);
  app.duplicates.merge({ ...input,dry_run:false,proposal_token:proposal.proposal_token });
  const target = app.memory.get({ id:input.target_id });
  const source = app.memory.get({ id:'future-source',include_deleted:true });
  assert.ok(target.updated_at >= updated_at); assert.ok(source.updated_at >= updated_at);
  assert.ok(source.deleted_at); assert.ok(target.content.includes('Source knowledge'));
});
