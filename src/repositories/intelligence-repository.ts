import type { Scope, Filters, Memory } from '../domain/memory.ts';
import type { StoredEmbedding, Enrichment, Job } from '../domain/intelligence.ts';

export interface ToolMetric { tool: string; calls: number; errors: number; average_ms: number; max_ms: number }
export interface IntelligenceStats {
  embeddings: number;
  enrichments: number;
  pending_jobs: number;
  /** Only these two operational metric collections are database-global. */
  metrics_scope: 'whole_database';
  tool_metrics: ToolMetric[];
  recent_imports: { importer: string; stats: unknown; created_at: string }[];
}

export interface IntelligenceRepository {
  candidates(filters: Filters, limit: number, maxBytes: number): { memories:Memory[];truncated:boolean };
  findFiltered(ids: string[], filters: Filters): Memory[];
  pendingEmbeddings(scope: Scope, provider: string, model: string, limit: number, force: boolean, afterId?:string): Memory[];
  saveEmbedding(embedding: StoredEmbedding, scope: Scope): boolean;
  vectors(filters: Filters, provider: string, model: string, limit: number, maxBytes: number): { embeddings:StoredEmbedding[];truncated:boolean };
  enrichment(id: string, scope: Scope): Enrichment | null;
  saveEnrichment(value: Enrichment, scope: Scope): boolean;
  markApplied(id: string, hash: string, scope: Scope): boolean;
  enqueue(memory: Memory, restart?: boolean): Job;
  claimJob(scope: Scope, leaseMs: number, id?: string): Job | null;
  ownsJob(id: string, token: string): boolean;
  finishJob(id: string, token: string, status: string, error?: string): void;
  saveMerge(target: Memory, source: Memory): void;
  recordGlobalToolMetrics(tool: string, elapsed: number, error: boolean): void;
  recordGlobalImportMetrics(importer: string, stats: unknown): void;
  stats(scope: Scope): IntelligenceStats;
  expired(scope: Scope, limit: number): Memory[];
  rebuildFts(): void;
  vacuum(): void;
}
