import { z } from 'zod';
import { scopeSchema, searchSchema, mutableSchema } from './memory.ts';
import { graphName, attributesSchema } from './graph.ts';

export const hybridSchema = searchSchema.extend({ mode: z.enum(['lexical', 'semantic', 'hybrid']).default('hybrid'), graph_context: z.boolean().default(true) });
export const embedSchema = scopeSchema.extend({ ids: z.array(graphName).min(1).max(100).optional(), limit: z.number().int().min(1).max(1000).default(100), force: z.boolean().default(false),after_id:graphName.optional() });
export const duplicatesSchema = scopeSchema.extend({ id: graphName, mode: z.enum(['text', 'semantic', 'hybrid']).default('text'), threshold: z.number().min(0).max(1).optional(), limit: z.number().int().min(1).max(100).default(10), max_candidates: z.number().int().min(1).max(5000).default(1000) });
export const mergeSchema = scopeSchema.extend({ target_id: graphName, source_ids: z.array(graphName).min(1).max(20),
  content: mutableSchema.shape.content, title: mutableSchema.shape.title, dry_run: z.boolean().default(true), proposal_token: z.string().length(64).optional() });
export const enrichmentResultSchema = z.object({ summary: z.string().max(4096), type: graphName.optional(), tags: z.array(graphName).max(64).default([]), importance: z.number().int().min(1).max(10).optional(),
  entities: z.array(z.object({ name: graphName, type: graphName.default('Other'), aliases: z.array(graphName).max(32).default([]), attributes: attributesSchema.optional() }).strict()).max(30).default([]),
  relations: z.array(z.object({ source: graphName, predicate: graphName, target: graphName, confidence: z.number().min(0).max(1).default(0.5) }).strict()).max(60).default([]),
  conflicts: z.array(z.string().max(512)).max(20).default([]),
}).strict();
export type EnrichmentResult = z.infer<typeof enrichmentResultSchema>;
export const enrichSchema = scopeSchema.extend({ id: graphName, action: z.enum(['run', 'get', 'apply', 'enqueue']).default('run') });
export const maintenanceSchema = scopeSchema.extend({ action: z.enum(['expire', 'orphans', 'fts-rebuild', 'graph-check', 'embeddings', 'enrichment-jobs', 'duplicates', 'vacuum', 'stats']),
  dry_run: z.boolean().default(true), limit: z.number().int().min(1).max(1000).default(100), id: graphName.optional(),after_id:graphName.optional() });
export type StoredEmbedding = { memory_id: string; provider: string; model: string; dimensions: number; vector: number[]; content_hash: string; created_at: string };
export type Enrichment = { memory_id: string; provider: string; model: string; content_hash: string; result: EnrichmentResult; created_at: string; applied_at: string | null };
export type Job = { id: string; memory_id: string; content_hash: string; status: string; attempts: number; lease_until: number | null; lease_token: string | null; last_error: string | null };
