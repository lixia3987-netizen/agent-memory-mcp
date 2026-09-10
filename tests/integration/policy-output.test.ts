import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../helpers.ts';
import { asAppError } from '../../src/shared/errors.ts';

const validationError = (error: unknown) => asAppError(error).code === 'VALIDATION_ERROR';

test('redaction expansion cannot bypass configured content limits or partially update a memory', async t => {
  const app = await application(t, { policy:{ secretAction:'redact',maxContentBytes:1024 } });
  const original = app.memory.add({ content:'Keep this original',importance:5 }).memory;
  const expanding = 'password=a '.repeat(60); // 660 raw bytes, 1,200 redacted bytes.
  assert.throws(() => app.memory.add({ content:expanding }), validationError);
  assert.throws(() => app.memory.update({ id:original.id,updates:{ content:expanding,importance:9 } }), validationError);
  assert.equal(app.memory.list({}).total, 1);
  const { expired:_,...stored } = app.memory.get({ id:original.id });
  assert.deepEqual(stored, original);
});

test('redaction preserves title, metadata and 64 KiB content schema limits', async t => {
  const app = await application(t, { policy:{ secretAction:'redact' } });
  const cases = [
    { content:'Safe body',title:'password=a '.repeat(40) },
    { content:'Safe body',metadata:{ entries:Array.from({ length:700 }, () => ({ password:'a' })) } },
    { content:'password=a '.repeat(4000) },
  ];
  for (const input of cases) assert.throws(() => app.memory.add(input), validationError);
  assert.equal(app.memory.list({}).total, 0);
});

test('imports and merge previews enforce transformed size limits without committing partial results', async t => {
  const app = await application(t, { policy:{ secretAction:'redact',maxContentBytes:1024 } });
  const data = JSON.stringify({ schemaVersion:1,exportedAt:new Date().toISOString(),memories:[
    { content:'Valid earlier input' },{ content:'password=a '.repeat(60) },
  ] });
  await assert.rejects(() => app.imports.run({ format:'json',data,dry_run:false }), validationError);
  assert.equal(app.memory.list({}).total, 0);
  const target = app.memory.add({ content:'Target stays' }).memory;
  const source = app.memory.add({ content:'Source stays' }).memory;
  assert.throws(() => app.duplicates.merge({ target_id:target.id,source_ids:[source.id],content:'password=a '.repeat(60) }), validationError);
  assert.equal(app.memory.list({}).total, 2);
  assert.equal(app.memory.get({ id:target.id }).content, target.content);
  assert.equal(app.memory.get({ id:source.id }).deleted_at, null);
});

test('accepted redacted records round-trip losslessly and remain editable after switching to reject', async t => {
  const source = await application(t, { policy:{ secretAction:'redact' } });
  const target = await application(t, { policy:{ secretAction:'reject' } });
  const original = source.memory.add({ content:JSON.stringify(['password=abc"def','safe']),title:'password=a',metadata:{ password:'a' } }).memory;
  for (const format of ['json','markdown'] as const) {
    const data = source.exports.run({ format }).data;
    await target.imports.run({ format,data,dry_run:false });
    const { expired:_,...stored } = target.memory.get({ id:original.id });
    assert.deepEqual(stored, original);
  }
  assert.equal(target.memory.update({ id:original.id,updates:{ importance:7 } }).importance, 7);
  assert.deepEqual(JSON.parse(original.content), ['password=[REDACTED]','safe']);
});
