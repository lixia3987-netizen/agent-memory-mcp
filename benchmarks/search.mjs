import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrap } from '../dist/app/bootstrap.js';
import { searchSchema } from '../dist/domain/memory.js';
import { SqliteMemoryRepository } from '../dist/infra/sqlite/memory-repository.js';
import { SqliteIntelligenceRepository } from '../dist/infra/sqlite/intelligence-repository.js';
import { LegacySearch } from '../tests/fixtures/legacy-search.ts';

const sizes = (process.env.BENCHMARK_SIZES ?? '50000,100000').split(',').map(Number);
assert.ok(sizes.length && sizes.every((n, i) => Number.isInteger(n) && n >= 1000 && n <= 100000 && (!i || n > sizes[i - 1])));
const samples = Number(process.env.BENCHMARK_SAMPLES ?? 30);
assert.ok(Number.isInteger(samples) && samples >= 30 && samples <= 100);
const tied = process.env.BENCHMARK_ORDER === 'tied';
const output = path.resolve(process.argv[2] ?? 'test-results/search-benchmark.json');
const homeDir = mkdtempSync(path.join(tmpdir(), 'agent-memory-benchmark-'));
const realNow = Date.now, fixedNow = realNow();
const report = { node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostMemoryMiB: totalmem() / 1048576,
  order: tied ? 'equal timestamps, ascending IDs' : 'newer timestamps appended last',
  method: 'Fresh deterministic mixed-language corpus; one namespace/null project; 3 warmups, alternating old/new order, >=30 warm-cache samples; compiled service validation/decode included. First-call timing is not a cold-disk guarantee.',
  concurrencyMethod: 'Separate HTTP MCP server/client processes. Each search-entry IPC barrier launches one memory_get and one memory_stats concurrently; one search per round. Both variants use schema 105 stats indexes; legacy FTS is synchronous, optimized FTS uses the production worker. 3 warmups then >=30 rounds, no models. Event-loop delay uses 10ms resolution.',
  results: [] };
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1), rawMs: values };
}
function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), 30000);
    const exit = code => finish(new Error(`Server exited with ${code} before ${type}`));
    const onError = error => finish(error);
    const message = value => { if (value?.type === type) finish(null, value); };
    function finish(error, value) {
      clearTimeout(timer); child.off('exit', exit); child.off('error', onError); child.off('message', message);
      if (error) reject(error); else resolve(value);
    }
    child.on('exit', exit); child.on('error', onError); child.on('message', message);
  });
}
async function httpBenchmark(variant, records) {
  const token = 'synthetic-benchmark-token-abcdefghijklmnopqrstuvwxyz';
  const child = fork(new URL('./http-server.mjs', import.meta.url), [homeDir, variant, String(fixedNow)], {
    env: { ...process.env, BENCHMARK_HTTP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8000); });
  try {
    const { url } = await waitMessage(child, 'ready');
    let id = 0;
    async function call(name, args) {
      const started = performance.now();
      const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`,
      }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(response.status, 200);
      const rpc = await response.json(); assert.ok(!rpc.error && !rpc.result.isError, JSON.stringify(rpc));
      const payload = rpc.result.structuredContent;
      if (name === 'memory_search') assert.equal(payload.memories.length, 10);
      if (name === 'memory_get') assert.equal(payload.id, 'bench-000000');
      if (name === 'memory_stats') assert.equal(payload.active, records);
      return performance.now() - started;
    }
    const times = { search: [], get: [], stats: [] };
    for (let i = -3; i < samples; i++) {
      if (i === 0) { const ready = waitMessage(child, 'measuring'); child.send({ type: 'measure' }); await ready; await delay(20); }
      const entered = waitMessage(child, 'search-start');
      const search = call('memory_search', { query: 'SQLite', limit: 10 });
      // Observe both failures immediately, including failures before the barrier.
      await Promise.race([entered, search.then(() => { throw new Error('Missing search barrier'); })]);
      const [searchMs, getMs, statsMs] = await Promise.all([search, call('memory_get', { id: 'bench-000000' }), call('memory_stats', {})]);
      if (i >= 0) { times.search.push(searchMs); times.get.push(getMs); times.stats.push(statsMs); }
    }
    const stopped = waitMessage(child, 'stopped'), exited = once(child, 'exit');
    child.send({ type: 'stop' }); const { metrics } = await stopped; await exited;
    return { variant, ...Object.fromEntries(Object.entries(times).map(([key, values]) => [key, distribution(values)])), eventLoop: metrics };
  } catch (error) { error.message += '\n' + stderr; throw error; }
  finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
}

let app, db;
try {
  const start = performance.now(); app = await bootstrap({ homeDir, namespace: 'benchmark', logLevel: 'error' });
  report.emptyBootstrapMs = performance.now() - start; report.emptyRssMiB = process.memoryUsage().rss / 1048576;
  db = new DatabaseSync(app.config.dbPath, { readOnly: true });
  report.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
  const old = new LegacySearch(db, app.config);
  let seeded = 0;
  for (const records of sizes) {
    Date.now = realNow;
    const seedStart = performance.now();
    for (let batch = seeded; batch < records; batch += 100) app.memory.repository.transaction(() => {
      for (let i = batch; i < Math.min(records, batch + 100); i++) app.memory.createRecord({
        id: `bench-${String(i).padStart(6, '0')}`,
        content: `Note ${i}: topic${String(i % 1000).padStart(4, '0')} uses SQLite for local storage. AI大模型需要长期记忆和可靠的检索。项目保留原始资料，提供导入导出和备份恢复，支持Windows部署。 Sample record ${i} has distinct content for repeatable search measurement.`,
        title: `Project note ${i}`, tags: ['benchmark', `topic${i % 1000}`],
        created_at: new Date(fixedNow - (100000 - i) * 1000).toISOString(),
        updated_at: new Date(tied ? fixedNow : fixedNow - (100000 - i) * 1000).toISOString(),
      }, 'benchmark');
    });
    seeded = records;
    const result = { records, incrementalSeedMs: performance.now() - seedStart, queries: [], http: [] };
    assert.equal(app.memory.list({}).total, records);
    Date.now = () => fixedNow;
    for (const query of ['SQLite', 'topic0042', '长期记忆', 'AI 大模型', 'AI 模型']) {
      const input = { query, limit: 10 };
      const run = { legacy: () => { const { query: q, ...filters } = searchSchema.parse(input); return old.search(q, app.memory.filters(filters)); }, optimized: () => app.memory.search(input).memories };
      const firstStart = performance.now(); const first = run.optimized(); const firstCallMs = performance.now() - firstStart;
      const expected = run.legacy(); assert.deepEqual(first, expected); assert.equal(expected.length, query === 'topic0042' ? Math.min(10, Math.floor((records + 957) / 1000)) : 10);
      for (let i = 0; i < 3; i++) { run.legacy(); run.optimized(); }
      const values = { legacy: [], optimized: [] };
      for (let i = 0; i < samples; i++) for (const variant of i % 2 ? ['optimized', 'legacy'] : ['legacy', 'optimized']) {
        const started = performance.now(); const hits = run[variant](); values[variant].push(performance.now() - started);
        assert.deepEqual(hits, expected, `${query}: every timed result must equal the frozen old query`);
      }
      const measurements = { query, firstCallMs, legacy: distribution(values.legacy), optimized: distribution(values.optimized) };
      result.queries.push(measurements);
      console.log(JSON.stringify({ records, query, oldP95Ms: measurements.legacy.p95Ms, newP95Ms: measurements.optimized.p95Ms }));
    }
    const memoryStats = new SqliteMemoryRepository(db, app.config);
    const intelligenceStats = new SqliteIntelligenceRepository(db);
    const scope = app.memory.scope({});
    const readStats = () => ({ ...memoryStats.stats(scope), ...intelligenceStats.stats(scope) });
    const statsExpected = readStats(), statsPrepare = db.prepare.bind(db);
    result.stats = {};
    for (const variant of ['oldHashIndexPlan', 'coveringIndex']) {
      db.prepare = variant === 'oldHashIndexPlan'
        ? sql => statsPrepare(sql.replace('FROM memories WHERE', 'FROM memories INDEXED BY idx_memory_hash WHERE')
          .replaceAll('JOIN memories m ON', 'JOIN memories m INDEXED BY idx_memory_hash ON')) : statsPrepare;
      try {
        for (let i = 0; i < 3; i++) readStats();
        const times = [];
        for (let i = 0; i < samples; i++) { const t = performance.now(); const counts = readStats(); times.push(performance.now() - t); assert.deepEqual(counts, statsExpected); }
        result.stats[variant] = distribution(times);
      } finally { db.prepare = statsPrepare; }
    }
    console.log(JSON.stringify({ records, statsOldPlanP95Ms: result.stats.oldHashIndexPlan.p95Ms, statsNewP95Ms: result.stats.coveringIndex.p95Ms }));
    // Capture the actual compiled query plan without exposing internals in product APIs.
    const prepare = db.prepare.bind(db); const plans = [];
    db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith('WITH ranked')) {
        const all = statement.all.bind(statement);
        statement.all = (...params) => { plans.push(prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)); return all(...params); };
      }
      return statement;
    };
    try { new SqliteMemoryRepository(db, app.config).search('SQLite', app.memory.filters({})); }
    finally { db.prepare = prepare; }
    result.queryPlan = plans[0];
    result.databaseAndWalMiB = app.backups.size() / 1048576;
    result.loadedRssMiB = process.memoryUsage().rss / 1048576;
    Date.now = realNow;
    for (const variant of ['legacy', 'optimized']) {
      const http = await httpBenchmark(variant, records); result.http.push(http);
      console.log(JSON.stringify({ records, http: variant, searchP95Ms: http.search.p95Ms, getP95Ms: http.get.p95Ms,
        statsP95Ms: http.stats.p95Ms, eventLoopP95Ms: http.eventLoop.p95Ms }));
    }
    report.results.push(result);
    mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  Date.now = realNow; db?.close(); await app?.close(); rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`Raw distributions and query plans: ${output}`);
