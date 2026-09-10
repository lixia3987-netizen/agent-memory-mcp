import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bootstrap } from '../../src/app/bootstrap.ts';
import { application, cleanup } from '../helpers.ts';
import { TestEmbedding, TestLlm } from '../fixtures/providers.ts';
import { textSimilarity } from '../../src/services/vector-math.ts';
import { frontmatter } from '../../src/importers/markdown.ts';

const json = (memories: unknown[]) => JSON.stringify({ schemaVersion: 1, exportedAt: '2026-01-01T00:00:00Z', memories });

for (const field of ['content', 'metadata'] as const) test(`redact to reject permits unrelated updates of persisted ${field}`, async t => {
  const old = await application(t, { policy: { secretAction: 'redact' } });
  const m = old.memory.add({ content: field === 'content' ? 'db password=real-value' : 'safe memory',
    ...(field === 'metadata' ? { metadata: { password: 'real-value' } } : {}) }).memory;
  old.close();
  const app = await bootstrap({ homeDir: old.config.homeDir, namespace: 'test', logLevel: 'error', policy: { secretAction: 'reject' } });
  cleanup(t, () => app.close());
  const updated = app.memory.update({ id: m.id, updates: { importance: 7 } });
  assert.equal(updated.importance, 7); assert.equal(updated.content, m.content); assert.deepEqual(updated.metadata, m.metadata);
  const imported = await app.imports.run({ format: 'json', conflict: 'update', dry_run: false,
    data: json([{ id: m.id, content: m.content, title: 'import edit' }]) });
  assert.equal(imported.updated, 1); assert.equal(app.memory.get({ id: m.id }).title, 'import edit');
  const source = app.memory.add({ content: 'additional safe evidence' }).memory;
  const preview = app.duplicates.merge({ target_id: m.id, source_ids: [source.id] });
  const merged = app.duplicates.merge({ target_id: m.id, source_ids: [source.id], dry_run: false, proposal_token: preview.proposal_token });
  assert.ok(merged.memory!.content.includes(m.content)); assert.ok(merged.memory!.content.includes(source.content));
  assert.throws(() => app.memory.update({ id: m.id, updates: { metadata: { password: '[REDACTED]real-secret' } } }), /Secret/);
});

test('reject exempts complete built-in placeholders without ignoring adjacent secrets or custom rules', async t => {
  const app = await application(t);
  for (const content of ['password=[REDACTED]', 'password="[REDACTED]"', 'authorization=Bearer [REDACTED]',
    JSON.stringify(['password=[REDACTED]', 'safe']), JSON.stringify({ password: '[REDACTED]' })]) {
    assert.doesNotThrow(() => app.memory.add({ content, metadata: { nested: [{ password: '[REDACTED]' }] } }));
  }
  for (const content of ['password=[REDACTED]real-secret', 'password="[REDACTED]"real-secret',
    'password=[REDACTED], api_key=real-secret', 'password=[redacted]', 'password=abc"fullsecret']) {
    assert.throws(() => app.memory.add({ content }), /Secret/);
  }
  const custom = await application(t, { policy: { secretPatterns: ['REDACTED'] } });
  assert.throws(() => custom.memory.add({ content: 'password=[REDACTED]' }), /Secret/);
});

test('bare credentials redact interior quotes and the entire value while preserving following text', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  for (const secret of ['abc"fullsecret', "abc'fullsecret", 'abc\\"fullsecret', 'abc"def\'fullsecret']) {
    for (const key of ['password=', 'authorization=Bearer ', 'authorization=Basic ']) {
      const result = app.memory.add({ content: key + secret + ' safe' }).memory.content;
      assert.equal(result, key.split('=')[0] + '=[REDACTED] safe');
      assert.equal(app.memory.update({ id: app.memory.add({ content: result }).memory.id, updates: { importance: 7 } }).content, result);
    }
  }
});

test('JSON redaction preserves escaped quotes, nested strings, numbers, layout and safe siblings', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  for (const secret of ['abc"fullsecret', "abc'fullsecret", 'abc\\"fullsecret', 'abc\\\\fullsecret']) {
    const source = JSON.stringify(['password=' + secret, { note: 'safe', nested: JSON.stringify(['password=' + secret]) }], null, 2);
    const result = app.memory.add({ content: source }).memory.content;
    const parsed = JSON.parse(result) as [string, { note: string; nested: string }];
    assert.equal(parsed[0], 'password=[REDACTED]'); assert.equal(parsed[1].note, 'safe');
    assert.deepEqual(JSON.parse(parsed[1].nested), ['password=[REDACTED]']);
    assert.ok(result.includes('\n  ')); assert.ok(!result.includes('fullsecret'));
  }
  const literal = '{ "n": 9007199254740993123, "password": "abc\\\"fullsecret", "safe": "\\u4e2d" }';
  assert.equal(app.memory.add({ content: literal }).memory.content, '{ "n": 9007199254740993123, "password": "[REDACTED]", "safe": "\\u4e2d" }');
});

test('quoted and unterminated credential values do not leak tails', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  for (const content of ['password="abc"fullsecret', "password='abc'fullsecret", 'password="abc fullsecret', "password='abc fullsecret"]) {
    const result = app.memory.add({ content }).memory.content;
    assert.ok(result.includes('[REDACTED]')); assert.ok(!result.includes('abc')); assert.ok(!result.includes('fullsecret'));
  }
  const rejected = await application(t);
  assert.throws(() => rejected.memory.add({ content: '{"passwo\\u0072d":"fullsecret"}' }), /Secret/);
});

test('built-in redaction remains parseable and reject-compatible across quote and escape combinations', async t => {
  const redact = await application(t, { policy: { secretAction: 'redact' } });
  const reject = await application(t);
  for (const a of ['"', "'", '\\', '🎉', '@', '!']) for (const b of ['"', "'", '\\', '中']) {
    const secret = 'abc' + a + b + 'fullsecret';
    const input = JSON.stringify({ notes: ['password=' + secret, 'safe'], password: secret + ',;}] tail',
      nested: JSON.stringify({ password: secret }), safe: 42 });
    const sanitized = redact.memory.policy.apply({ content: input }).content;
    assert.deepEqual(JSON.parse(sanitized), { notes: ['password=[REDACTED]', 'safe'], password: '[REDACTED]',
      nested: JSON.stringify({ password: '[REDACTED]' }), safe: 42 });
    assert.ok(!sanitized.includes('fullsecret'));
    assert.equal(redact.memory.policy.apply({ content: sanitized }).content, sanitized);
    assert.doesNotThrow(() => reject.memory.policy.apply({ content: sanitized }));
    assert.throws(() => reject.memory.policy.apply({ content: input }), /Secret/);
  }
  for (const password of [123, false, ['secret', { value: 'secret' }], { value: 'secret', nested: ['secret'] }]) {
    const input = JSON.stringify({ password, safe: 'keep' });
    assert.deepEqual(JSON.parse(redact.memory.policy.apply({ content: input }).content), { password: '[REDACTED]', safe: 'keep' });
  }
});

for (const hidden of ['deleted', 'expired'] as const) test(`derived stats exclude ${hidden} sources and recover with the same retained rows`, async t => {
  const app = await application(t, {}, { embedding: new TestEmbedding(), llm: new TestLlm() });
  const a = app.memory.add({ content: 'car evidence' }).memory;
  const b = app.memory.add({ content: 'fruit evidence' }).memory;
  await app.embeddings.rebuild({}); await app.enrichment.run({ id: a.id }); await app.enrichment.run({ id: b.id, action: 'enqueue' });
  const scope = app.memory.scope({}); const counts = () => {
    const { embeddings, enrichments, pending_jobs } = app.intelligence.stats(scope); return { embeddings, enrichments, pending_jobs };
  };
  assert.deepEqual(counts(), { embeddings: 2, enrichments: 1, pending_jobs: 1 });
  const other = app.memory.add({ content: 'other project', project: 'other' }).memory;
  await app.enrichment.run({ id: other.id, project: 'other', action: 'enqueue' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const m of [a, b]) {
    if (hidden === 'deleted') app.memory.delete({ id: m.id });
    else app.memory.update({ id: m.id, updates: { expires_at: new Date().toISOString() } });
  }
  assert.deepEqual(counts(), { embeddings: 0, enrichments: 0, pending_jobs: 0 });
  assert.equal(app.intelligence.claimJob(scope, 1000), null);
  assert.equal(app.intelligence.stats({ namespace: scope.namespace, project: 'other' }).pending_jobs, 1);
  const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  assert.equal(db.prepare('SELECT count(*) n FROM memory_embeddings').get()!.n, 2);
  for (const m of [a, b]) {
    if (hidden === 'deleted') app.memory.restore({ id: m.id });
    else app.memory.update({ id: m.id, updates: { expires_at: null } });
  }
  assert.deepEqual(counts(), { embeddings: 2, enrichments: 1, pending_jobs: 1 });
});

test('import metrics retain exactly the newest 100 rows, including gaps in IDs', async t => {
  const app = await application(t); const db = new DatabaseSync(app.config.dbPath); cleanup(t, () => db.close());
  for (let i = 1; i <= 101; i++) app.intelligence.recordGlobalImportMetrics('test', { i });
  const rows = () => db.prepare('SELECT id,stats_json FROM import_metrics ORDER BY id').all();
  assert.equal(rows().length, 100); assert.equal(JSON.parse(String(rows()[0]!.stats_json)).i, 2);
  db.exec('DELETE FROM import_metrics WHERE id % 2 = 0');
  for (let i = 102; i <= 177; i++) app.intelligence.recordGlobalImportMetrics('test', { i });
  assert.equal(rows().length, 100); assert.equal(JSON.parse(String(rows().at(-1)!.stats_json)).i, 177);
  const recent = app.intelligence.stats(app.memory.scope({})).recent_imports;
  assert.equal(recent.length, 10); assert.deepEqual(recent[0]!.stats, { i: 177 });
});

test('text similarity uses Unicode code points without crossing the duplicate threshold on emoji', async t => {
  const app = await application(t);
  const a = app.memory.add({ content: 'abc🎉defg' }).memory;
  const b = app.memory.add({ content: 'abc🎉defx' }).memory;
  assert.equal(textSimilarity(a.content, b.content), 5 / 6);
  assert.deepEqual(app.duplicates.find({ id: a.id }).candidates, []);
  assert.equal(app.duplicates.find({ id: a.id, threshold: .8 }).candidates[0]?.id, b.id);
  assert.equal(textSimilarity('🎉a', '🎉b'), 0);
  assert.equal(textSimilarity('Ａ\n🎉B', 'a 🎉b'), 1);
  assert.equal(textSimilarity('abcdefg', 'abcdefx'), .8);
});

test('empty frontmatter is valid with LF or CRLF while closing delimiters still occupy a whole line', async t => {
  const app = await application(t);
  for (const text of ['---\n---\nbody', '---\n\n---\nbody', '\uFEFF---\r\n---\r\nbody']) {
    assert.deepEqual(frontmatter(text), { attributes: {}, body: 'body' });
    assert.equal((await app.imports.run({ format: 'markdown', data: text, dry_run: true })).added, 1);
  }
  assert.deepEqual(frontmatter('---\n---'), { attributes: {}, body: '' });
  assert.deepEqual(frontmatter('---\n---\nbody\n---\nmore'), { attributes: {}, body: 'body\n---\nmore' });
  assert.throws(() => frontmatter('---\nname: value---\nbody'), /closing delimiter/);
  assert.throws(() => frontmatter('---\nname: value\n---suffix\nbody'), /closing delimiter/);
  assert.throws(() => frontmatter('---\nname: [\n---\nbody'), /invalid YAML/);
});
