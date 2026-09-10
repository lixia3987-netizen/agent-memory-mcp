import type { Filters, SearchHit } from '../domain/memory.ts';

/** Read-only, bounded search executor; the invocation time defines TTL/ranking. */
export interface AsyncSearch {
  search(query: string, filters: Filters, now: number): Promise<SearchHit[]>;
  close(): Promise<void>;
}
