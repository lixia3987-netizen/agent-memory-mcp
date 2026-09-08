import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { bootstrap } from '../src/app/bootstrap.ts';
import type { ConfigOverrides } from '../src/app/config.ts';

export function temporary(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-memory-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
export async function application(t: TestContext, overrides: ConfigOverrides = {}, providers: Parameters<typeof bootstrap>[1] = {}) {
  const home = temporary(t);
  const app = await bootstrap({ homeDir: home, namespace: 'test', logLevel: 'error', ...overrides },providers);
  t.after(() => app.close());
  return app;
}
