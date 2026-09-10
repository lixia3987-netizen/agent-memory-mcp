import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../../app/config.ts';
import type { Filters } from '../../domain/memory.ts';
import { asAppError } from '../../shared/errors.ts';
import { SqliteMemoryRepository } from './memory-repository.ts';

const config = workerData as Pick<AppConfig, 'dbPath' | 'busyTimeoutMs' | 'search'>;
const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs}; PRAGMA query_only=ON;`);
const repository = new SqliteMemoryRepository(db, config);
parentPort!.on('message', (message: { type: string; id: number; query: string; filters: Filters; now: number }) => {
  if (message.type === 'close') { db.close(); parentPort!.close(); return; }
  try { parentPort!.postMessage({ id: message.id, hits: repository.search(message.query, message.filters, message.now) }); }
  catch (error) { const e = asAppError(error); parentPort!.postMessage({ id: message.id, error: { code: e.code, message: e.message, retryable: e.retryable } }); }
});
