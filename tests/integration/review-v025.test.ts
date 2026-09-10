import { test } from 'node:test';
import assert from 'node:assert/strict';
import { application, cleanup } from '../helpers.ts';
import { bootstrap } from '../../src/app/bootstrap.ts';

test('merge preserves stale source and target evidence while carrying current facts', async t => {
  const app = await application(t);
  const sqlite = app.graph.entityAdd({ name: 'SQLite' }).entity;
  const postgres = app.graph.entityAdd({ name: 'PostgreSQL' }).entity;
  const records = ['source', 'target'].map(name => {
    const memory = app.memory.add({ content: `${name} uses SQLite.` }).memory;
    const entity = app.graph.entityAdd({ name }).entity;
    const stale = app.graph.relationAdd({ source_entity_id: entity.id, predicate: 'USES', target_entity_id: sqlite.id,
      source_memory_id: memory.id, valid_from: '2020-01-01T00:00:00Z' }).relation;
    app.memory.update({ id: memory.id, updates: { content: `${name} no longer uses SQLite; it now uses PostgreSQL.` } });
    const fresh = app.graph.relationAdd({ source_entity_id: entity.id, predicate: 'USES', target_entity_id: postgres.id,
      source_memory_id: memory.id, valid_from: '2021-01-01T00:00:00Z' }).relation;
    return { memory, stale, fresh };
  });
  const [source, target] = records;
  const args = { target_id: target!.memory.id, source_ids: [source!.memory.id] };
  const preview = app.duplicates.merge(args);
  assert.equal(app.graph.relationSearch({}).relations.length, 2);
  const merged = app.duplicates.merge({ ...args, dry_run: false, proposal_token: preview.proposal_token });
  assert.ok(merged.memory);
  const current = app.graph.relationSearch({}).relations;
  assert.deepEqual(new Set(current.map(r => r.id)), new Set(records.map(r => r.fresh.id)));
  for (const relation of current) {
    assert.equal(relation.source_memory_id, target!.memory.id);
    assert.equal(relation.source_content_hash, merged.memory.content_hash);
    assert.equal(relation.status, 'active');
  }
  const history = app.graph.relationSearch({ history: true, include_stale: true }).relations;
  for (const record of records) {
    const { active: _active, ...fact } = history.find(r => r.id === record.stale.id)!;
    assert.deepEqual(fact, record.stale, 'stale evidence keeps its original source, version and timestamps');
  }
});

test('custom merge content does not certify old source or target facts', async t => {
  const app = await application(t);
  const database = app.graph.entityAdd({ name: 'SQLite' }).entity;
  const records = ['source', 'target'].map(name => {
    const memory = app.memory.add({ content: `${name} uses SQLite.` }).memory;
    const entity = app.graph.entityAdd({ name }).entity;
    const relation = app.graph.relationAdd({ source_entity_id: entity.id, predicate: 'USES', target_entity_id: database.id,
      source_memory_id: memory.id, valid_from: '2020-01-01T00:00:00Z' }).relation;
    return { memory, relation };
  });
  const args = { target_id: records[1]!.memory.id, source_ids: [records[0]!.memory.id], content: 'Both projects no longer use SQLite.' };
  const preview = app.duplicates.merge(args);
  app.duplicates.merge({ ...args, dry_run: false, proposal_token: preview.proposal_token });
  assert.equal(app.graph.relationSearch({}).relations.length, 0);
  const history = app.graph.relationSearch({ at: '2020-06-01T00:00:00Z' }).relations;
  for (const record of records) {
    const { active: _active, ...fact } = history.find(r => r.id === record.relation.id)!;
    assert.deepEqual(fact, record.relation);
  }
});

test('merge leaves closed, inactive and deleted facts and deleted endpoints on their original evidence', async t => {
  const app = await application(t);
  const source = app.memory.add({ content: 'Original project history' }).memory;
  const target = app.memory.add({ content: 'Merged project history' }).memory;
  const project = app.graph.entityAdd({ name: 'Project' }).entity;
  const facts = ['closed', 'inactive', 'deleted', 'deleted-endpoint'].map(kind => {
    const endpoint = app.graph.entityAdd({ name: `Storage-${kind}` }).entity;
    const relation = app.graph.relationAdd({ source_entity_id: project.id, predicate: kind, target_entity_id: endpoint.id,
      source_memory_id: source.id, valid_from: '2020-01-01T00:00:00Z',
      ...(kind === 'closed' ? { valid_to: '2021-01-01T00:00:00Z' } : {}) }).relation;
    if (kind === 'inactive') app.graph.relationUpdate({ id: relation.id, updates: { status: 'inactive' } });
    if (kind === 'deleted') app.graph.relationUpdate({ id: relation.id, updates: { deleted: true } });
    if (kind === 'deleted-endpoint') app.graph.entityUpdate({ id: endpoint.id, updates: { deleted: true } });
    return relation.id;
  });
  const filters = { history: true, include_stale: true, include_deleted: true, include_inactive: true };
  const before = app.graph.relationSearch(filters).relations;
  const args = { target_id: target.id, source_ids: [source.id] };
  const preview = app.duplicates.merge(args);
  app.duplicates.merge({ ...args, dry_run: false, proposal_token: preview.proposal_token });
  assert.deepEqual(app.graph.relationSearch(filters).relations, before);
  assert.equal(before.length, facts.length);
});

test('merge retains superseded facts until their future replacement becomes valid', async t => {
  const app = await application(t);
  const source = app.memory.add({ content: 'SQLite until 2090, then PostgreSQL.' }).memory;
  const target = app.memory.add({ content: 'Storage schedule' }).memory;
  const project = app.graph.entityAdd({ name: 'Project' }).entity;
  const sqlite = app.graph.entityAdd({ name: 'SQLite' }).entity;
  const postgres = app.graph.entityAdd({ name: 'PostgreSQL' }).entity;
  const old = app.graph.relationAdd({ source_entity_id: project.id, predicate: 'USES', target_entity_id: sqlite.id,
    source_memory_id: source.id, valid_from: '2020-01-01T00:00:00Z' }).relation;
  const replacement = app.graph.relationAdd({ source_entity_id: project.id, predicate: 'USES', target_entity_id: postgres.id,
    source_memory_id: source.id, valid_from: '2090-01-01T00:00:00Z', conflict_strategy: 'supersede', supersedes: old.id }).relation;
  const args = { target_id: target.id, source_ids: [source.id] };
  const preview = app.duplicates.merge(args);
  app.duplicates.merge({ ...args, dry_run: false, proposal_token: preview.proposal_token });
  const before = app.graph.relationSearch({ at: '2089-01-01T00:00:00Z', include_stale: false }).relations;
  assert.equal(before.length, 1); assert.equal(before[0]!.id, old.id);
  assert.equal(before[0]!.superseded_by, replacement.id);
  assert.equal(before[0]!.valid_to, '2090-01-01T00:00:00.000Z');
  const after = app.graph.relationSearch({ at: '2091-01-01T00:00:00Z', include_stale: false }).relations;
  assert.equal(after.length, 1); assert.equal(after[0]!.id, replacement.id);
});

test('policy-redacted merge does not certify facts against rewritten evidence', async t => {
  const old = await application(t, { policy: { secretDetection: false } });
  const source = old.memory.add({ content: 'Project uses SQLite. token=synthetic-credential' }).memory;
  const target = old.memory.add({ content: 'Storage notes' }).memory;
  const project = old.graph.entityAdd({ name: 'Project' }).entity;
  const sqlite = old.graph.entityAdd({ name: 'SQLite' }).entity;
  const fact = old.graph.relationAdd({ source_entity_id: project.id, predicate: 'USES', target_entity_id: sqlite.id, source_memory_id: source.id }).relation;
  old.graph.link({ memory_id: source.id, entity_id: project.id, role: 'enriched' });
  old.graph.link({ memory_id: source.id, entity_id: sqlite.id, role: 'manual' });
  old.close();
  const app = await bootstrap({ homeDir: old.config.homeDir, namespace: 'test', logLevel: 'error', policy: { secretAction: 'redact' } });
  cleanup(t, () => app.close());
  const args = { target_id: target.id, source_ids: [source.id] };
  const preview = app.duplicates.merge(args);
  const merged = app.duplicates.merge({ ...args, dry_run: false, proposal_token: preview.proposal_token });
  assert.ok(merged.memory!.content.includes('token=[REDACTED]'));
  assert.equal(app.graph.relationSearch({}).relations.length, 0);
  assert.equal(app.graph.relationSearch({ history: true, include_stale: true }).relations[0]!.source_content_hash, fact.source_content_hash);
  assert.deepEqual(app.graph.linkedMemoryIds([project.id], app.memory.filters({}), 10), [], 'Rewritten content must not inherit derived enriched links');
  assert.deepEqual(app.graph.linkedMemoryIds([sqlite.id], app.memory.filters({}), 10), [target.id], 'Explicit manual links remain transferable');
});

test('token fields are rejected in body, JSON, nested metadata, update, import and merge', async t => {
  const app = await application(t);
  for (const content of ['token=synthetic-secret', 'TOKEN: "synthetic-secret"', '{"ToKeN":"synthetic-secret"}']) {
    assert.throws(() => app.memory.add({ content }), /Secret/);
  }
  assert.throws(() => app.memory.add({ content: 'Metadata fixture', metadata: { nested: [{ ToKeN: 'synthetic-secret' }] } }), /Secret/);
  const memory = app.memory.add({ content: 'Safe original' }).memory;
  assert.throws(() => app.memory.update({ id: memory.id, updates: { metadata: { token: 'synthetic-secret' } } }), /Secret/);
  await assert.rejects(() => app.imports.run({ format: 'markdown', data: 'token=synthetic-secret', dry_run: false }), /Secret/);
  const other = app.memory.add({ content: 'Safe source' }).memory;
  assert.throws(() => app.duplicates.merge({ target_id: memory.id, source_ids: [other.id], content: 'token=synthetic-secret' }), /Secret/);
  assert.equal(app.memory.list({}).total, 2);
});

test('token redaction preserves JSON and protects nested metadata', async t => {
  const app = await application(t, { policy: { secretAction: 'redact' } });
  const content = JSON.stringify({ ToKeN: 'synthetic-secret', note: 'token=another-secret', safe: 123 });
  const memory = app.memory.add({ content, metadata: { nested: [{ TOKEN: 'synthetic-secret' }] } }).memory;
  assert.deepEqual(JSON.parse(memory.content), { ToKeN: '[REDACTED]', note: 'token=[REDACTED]', safe: 123 });
  assert.deepEqual(memory.metadata, { nested: [{ TOKEN: '[REDACTED]' }] });
});

test('redacted token values remain editable after switching to reject', async t => {
  const old = await application(t, { policy: { secretAction: 'redact' } });
  const memory = old.memory.add({ content: 'token=synthetic-secret', metadata: { token: 'another-secret' } }).memory;
  old.close();
  const app = await bootstrap({ homeDir: old.config.homeDir, namespace: 'test', logLevel: 'error', policy: { secretAction: 'reject' } });
  cleanup(t, () => app.close());
  const updated = app.memory.update({ id: memory.id, updates: { importance: 8 } });
  assert.equal(updated.content, 'token=[REDACTED]');
  assert.deepEqual(updated.metadata, { token: '[REDACTED]' });
  assert.throws(() => app.memory.update({ id: memory.id, updates: { content: 'token=[REDACTED]real-secret' } }), /Secret/);
});

test('token terminology and unrelated field names remain ordinary memory', async t => {
  const app = await application(t);
  const input = { content: 'Token budgeting counts tokens; the tokenizer uses code points.',
    metadata: { token_count: 512, tokenizer: 'unicode', access_token_count: 1 } };
  const memory = app.memory.add(input).memory;
  assert.equal(memory.content, input.content); assert.deepEqual(memory.metadata, input.metadata);
});
