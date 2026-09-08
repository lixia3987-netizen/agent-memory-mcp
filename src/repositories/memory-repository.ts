import type { Filters, Memory, Scope, SearchHit } from '../domain/memory.ts';
import type { SyncOperation } from './transaction.ts';

export type ImportOrigin = Scope & { source_path: string; item_key: string; file_hash: string; memory_id: string };
export interface MemoryRepository {
  transaction<T>(operation: SyncOperation<T>, dryRun?: boolean): T;
  find(id: string, scope: Scope, includeDeleted?: boolean): Memory | null;
  /** Global primary-key collision guard for imports; never returns another scope's data. */
  hasGlobalIdCollision(id: string): boolean;
  duplicate(hash: string, scope: Scope, excludingId?: string): Memory | null;
  insert(memory: Memory): void;
  replace(memory: Memory): void;
  audit(memory: Pick<Memory, 'id' | 'namespace' | 'project'>, action: string): void;
  list(filters: Filters): { memories: Memory[]; total: number };
  exportRecords(filters: Filters, maxBytes: number): Memory[];
  search(query: string, filters: Filters): SearchHit[];
  importOrigin(origin: Omit<ImportOrigin, 'memory_id'>, exactHash: boolean): Memory | null;
  recordImport(origin: ImportOrigin): void;
  purge(filters: Filters, before: string): number;
  stats(scope: Scope): Record<string, number>;
}
