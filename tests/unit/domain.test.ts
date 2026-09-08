import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addSchema, timestamp } from '../../src/domain/memory.ts';
import { contentHash, normalizeContent } from '../../src/shared/hash.ts';
import { rankScore, literalFtsQuery } from '../../src/services/ranking.ts';
import { resolveConfig } from '../../src/app/config.ts';
import { asAppError } from '../../src/shared/errors.ts';
import { temporary } from '../helpers.ts';

test('validation rejects blank, oversized UTF-8, unknown fields, invalid importance and dates', () => {
  for (const data of [{ content: '  ' }, { content: '中'.repeat(23000) }, { content: 'ok', importance: 11 }, { content: 'ok', typo: true }, { content: 'ok', expires_at: 'tomorrow' }]) {
    assert.throws(() => addSchema.parse(data));
  }
  assert.equal(addSchema.parse({ content: 'ok', type: 'custom-type' }).type, 'custom-type');
  assert.equal(timestamp.parse('2026-09-08T16:00:00+08:00'), '2026-09-08T08:00:00.000Z');
});
test('hash normalization is scope-aware and Unicode aware', () => {
  assert.equal(normalizeContent(' A\r\n B '), 'A B');
  assert.equal(contentHash('a', null, 'A\r\n B'), contentHash('a', null, 'A B'));
  assert.equal(contentHash('a', null, 'e\u0301'), contentHash('a', null, 'é'));
  assert.notEqual(contentHash('a', 'p', 'x'), contentHash('a', null, 'x'));
  assert.notEqual(contentHash('a', null, 'x'), contentHash('b', null, 'x'));
});
test('ranking keeps relevance primary and escapes literal FTS input', () => {
  const now = Date.now();
  assert.ok(rankScore(-10, 1, now - 1e12, now, .12, .08) > rankScore(-1, 10, now, now, .12, .08));
  assert.equal(rankScore(0, 10, now, now, .12, .08), 0);
  assert.equal(literalFtsQuery('a OR "x"'), '"a" AND "OR" AND """x"""');
});
test('config precedence is CLI > environment > file > defaults', t => {
  const home = temporary(t); const config = path.join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ namespace: 'file', project: 'file-project', logLevel: 'warn' }));
  const resolved = resolveConfig({ config, homeDir: home, namespace: 'cli' }, { AGENT_MEMORY_NAMESPACE: 'env', AGENT_MEMORY_LOG_LEVEL: 'debug' });
  assert.equal(resolved.namespace, 'cli'); assert.equal(resolved.logLevel, 'debug'); assert.equal(resolved.project, 'file-project');
  assert.equal(resolveConfig({ config, homeDir: home }, { AGENT_MEMORY_NAMESPACE: 'env' }).namespace, 'env');
  assert.throws(() => resolveConfig({ config: path.join(home, 'absent.json') }, {}));
  mkdirSync(path.join(home, 'config')); writeFileSync(path.join(home, 'config', 'config.json'), '{bad');
  assert.throws(() => resolveConfig({ homeDir: home }, {}));
});
test('errors classify busy and permission failures without leaking database details', () => {
  assert.equal(asAppError({ errcode: 5 }).code, 'DATABASE_BUSY');
  assert.equal(asAppError({ code: 'EACCES' }).code, 'PERMISSION_DENIED');
  assert.ok(!asAppError(new Error('secret memory content')).message.includes('secret'));
});
