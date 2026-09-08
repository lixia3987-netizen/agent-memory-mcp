import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporary } from '../helpers.ts';
import { bootstrap } from '../../src/app/bootstrap.ts';

test('four processes concurrently initialize, read and write one WAL DB without duplicate races', { timeout: 60000 }, async t => {
  const home = temporary(t); const writer = fileURLToPath(new URL('../fixtures/writer.ts', import.meta.url));
  await Promise.all([0, 1, 2, 3].map(i => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [writer, home, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const app = await bootstrap({ homeDir: home, namespace: 'concurrency' });
  try { assert.equal(app.memory.list({}).total, 121); assert.equal(app.memory.search({ query: 'shared' }).memories.length, 1); assert.equal(app.doctor().integrity, 'ok'); }
  finally { app.close(); }
});
