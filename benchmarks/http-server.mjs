// A separate server process keeps the load generator's clock off SQLite's thread.
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { bootstrap } from '../dist/app/bootstrap.js';
import { serveHttp } from '../dist/mcp/http.js';
import { LegacySearch } from '../tests/fixtures/legacy-search.ts';

const [homeDir, variant, fixedNow] = process.argv.slice(2);
Date.now = () => Number(fixedNow);
const app = await bootstrap({ homeDir, namespace: 'benchmark', logLevel: 'error',
  http: { enabled: true, port: 0, tokenEnv: 'BENCHMARK_HTTP_TOKEN' } });
let legacyDb;
const legacy = variant === 'legacy'
  ? new LegacySearch(legacyDb = new DatabaseSync(app.config.dbPath, { readOnly: true }), app.config) : undefined;
const search = app.memory.searchAsync.bind(app.memory);
app.memory.searchAsync = async input => {
  process.send({ type: 'search-start' });
  if (!legacy) return search(input);
  const { query, ...filters } = input;
  return { memories: legacy.search(query, app.memory.filters(filters)), query, mode: 'lexical' };
};
const listener = await serveHttp(app);
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
process.on('message', async message => {
  if (message.type === 'measure') {
    lag.reset(); process.send({ type: 'measuring' });
  } else if (message.type === 'stop') {
    lag.disable();
    const metrics = { p50Ms: lag.percentile(50) / 1e6, p95Ms: lag.percentile(95) / 1e6,
      maxMs: lag.max / 1e6, samples: lag.count, rssMiB: process.memoryUsage().rss / 1048576 };
    await listener.close(); legacyDb?.close(); await app.close();
    process.send({ type: 'stopped', metrics }, () => process.disconnect());
  }
});
process.send({ type: 'ready', url: listener.url });
