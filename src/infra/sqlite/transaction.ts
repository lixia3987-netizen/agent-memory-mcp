import type { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction } from 'node:util/types';
import type { SyncOperation } from '../../repositories/transaction.ts';
import { AppError } from '../../shared/errors.ts';

// All repository instances sharing a connection share its nesting state.
const depths = new WeakMap<DatabaseSync, number>();
export function transaction<T>(db: DatabaseSync, operation: SyncOperation<T>, dryRun = false): T {
  if (isAsyncFunction(operation)) throw new AppError('VALIDATION_ERROR', 'SQLite transaction callbacks must be synchronous. Await work before opening a transaction.');
  const depth = depths.get(db) ?? 0;
  const nested = depth > 0;
  const savepoint = `memory_nested_${depth}`;
  depths.set(db, depth + 1);
  try {
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = operation();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        // Observe a returned promise's rejection; do not commit its synchronous
        // prefix. This cannot cancel work scheduled by a contract-violating caller.
        void Promise.resolve(result).catch(() => {});
        throw new AppError('VALIDATION_ERROR', 'SQLite transaction callbacks must not return promises or thenables.');
      }
      if (dryRun) db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      else if (!nested) db.exec('COMMIT');
      if (nested) db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  } finally {
    if (depth) depths.set(db, depth); else depths.delete(db);
  }
}
