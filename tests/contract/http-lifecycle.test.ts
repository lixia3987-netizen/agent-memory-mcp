import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { application, cleanup } from '../helpers.ts';
import { serveHttp } from '../../src/mcp/http.ts';
import { AppError } from '../../src/shared/errors.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const token = 'synthetic-http-lifecycle-token-abcdefghijklmnopqrstuvwxyz';
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` };
function rpc(id: number, name = 'memory_stats') {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: name === 'memory_reindex' ? { force: true } : {} } });
}
async function stats(url: string): Promise<number> {
  const response = await fetch(url, { method: 'POST', headers, body: rpc(100), signal: AbortSignal.timeout(5000) });
  await response.text();
  return response.status;
}
async function waitForCapacity(url: string) {
  for (let i = 0; i < 100; i++) {
    const status = await stats(url);
    if (status === 200) return;
    assert.equal(status, 429);
    await delay(10);
  }
  assert.fail('Completed or failed tools must release HTTP capacity after disconnect');
}

for (const capacity of [1, 20]) test(`HTTP cancellation retains ${capacity} in-flight slots until success/error, then recovers for repeated rounds`, async t => {
  const tokenEnv = `HTTP_LIFECYCLE_TOKEN_${capacity}`;
  const previous = process.env[tokenEnv]; process.env[tokenEnv] = token;
  cleanup(t, () => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
  let gate = deferred(), entered = deferred(), started = 0, shouldFail = false;
  const provider = { id: 'lifecycle-test', model: 'fixture', dimensions: () => 2, embed: async (texts: string[]) => {
    if (++started === capacity) entered.resolve();
    await gate.promise;
    if (shouldFail) throw new AppError('PROVIDER_UNAVAILABLE', 'Synthetic provider failure');
    return texts.map(() => [1, 0]);
  } };
  const app = await application(t, { http: { enabled: true, port: 0, tokenEnv, ...(capacity === 1 ? { maxConcurrentRequests: 1 } : {}) } }, { embedding: provider });
  assert.equal(app.config.http.maxConcurrentRequests, capacity, '20 verifies the default configuration');
  app.memory.add({ content: 'HTTP cancellation fixture' });
  const listener = await serveHttp(app);
  cleanup(t, () => listener.close());
  cleanup(t, () => { gate.resolve(); listener.server.closeAllConnections(); });
  for (const fail of [false, true, false]) {
    gate = deferred(); entered = deferred(); started = 0; shouldFail = fail;
    const disconnected = deferred(); let closed = 0;
    const observe = (_req: unknown, res: import('node:http').ServerResponse) => {
      res.once('close', () => { if (++closed === capacity) disconnected.resolve(); });
    };
    listener.server.on('request', observe);
    const controllers = Array.from({ length: capacity }, () => new AbortController());
    const requests = controllers.map((controller, i) => fetch(listener.url, { method: 'POST', headers,
      body: rpc(i + 1, 'memory_reindex'), signal: controller.signal }).then(response => response.text(), error => error.name));
    await entered.promise;
    listener.server.off('request', observe);
    controllers.forEach(controller => controller.abort());
    assert.ok((await Promise.all(requests)).every(result => result === 'AbortError'));
    await disconnected.promise;
    assert.equal(await stats(listener.url), 429, 'Disconnect must not bypass the actual work limit');
    gate.resolve();
    await waitForCapacity(listener.url);
  }
  assert.equal(app.maintenance.stats({}).embeddings, 1);
  const invalid = await fetch(listener.url, { method: 'POST', headers, body: '{' });
  assert.equal(invalid.status, 400); await invalid.text();
  assert.equal(await stats(listener.url), 200, 'Malformed input also releases its slot');
});

test('HTTP shutdown drains disconnected tools before the application can close its database', async t => {
  const tokenEnv = 'HTTP_LIFECYCLE_SHUTDOWN_TOKEN'; const previous = process.env[tokenEnv]; process.env[tokenEnv] = token;
  cleanup(t, () => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
  const gate = deferred(), entered = deferred(), disconnected = deferred();
  const provider = { id: 'shutdown-test', model: 'fixture', dimensions: () => 2, embed: async (texts: string[]) => {
    entered.resolve(); await gate.promise; return texts.map(() => [1, 0]);
  } };
  const app = await application(t, { http: { enabled: true, port: 0, tokenEnv } }, { embedding: provider });
  app.memory.add({ content: 'HTTP shutdown fixture' });
  const listener = await serveHttp(app);
  cleanup(t, () => listener.close());
  cleanup(t, () => { gate.resolve(); listener.server.closeAllConnections(); });
  listener.server.once('request', (_req, res) => res.once('close', disconnected.resolve));
  const controller = new AbortController();
  const request = fetch(listener.url, { method: 'POST', headers, body: rpc(1, 'memory_reindex'), signal: controller.signal }).catch(error => error.name);
  await entered.promise; controller.abort(); assert.equal(await request, 'AbortError'); await disconnected.promise;
  let drained = false;
  const closing = listener.close().then(() => { drained = true; });
  await delay(20);
  assert.equal(drained, false, 'Closing sockets alone must not close the database while a tool is running');
  gate.resolve(); await closing;
  assert.equal(app.maintenance.stats({}).embeddings, 1);
  await listener.close(); // cleanup remains idempotent
});
