import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { bootstrap } from '../src/app/bootstrap.ts';
import type { ConfigOverrides } from '../src/app/config.ts';

const cleanups = new WeakMap<TestContext, Array<() => unknown>>();
/** Close clients/connections before deleting their files, including on Windows. */
export function cleanup(t: TestContext, operation: () => unknown): void {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = []; cleanups.set(t, stack);
    t.after(async () => {
      const errors: unknown[] = [];
      for (const close of stack!.reverse()) {
        try { await close(); } catch (error) { errors.push(error); }
      }
      cleanups.delete(t);
      if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed');
    });
  }
  stack.push(operation);
}

export function temporary(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-memory-test-'));
  cleanup(t, () => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
export async function application(t: TestContext, overrides: ConfigOverrides = {}, providers: Parameters<typeof bootstrap>[1] = {}) {
  const home = temporary(t);
  const app = await bootstrap({ homeDir: home, namespace: 'test', logLevel: 'error', ...overrides },providers);
  cleanup(t, () => app.close());
  return app;
}
