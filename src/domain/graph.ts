import { z } from 'zod';
import { scopeSchema, timestamp } from './memory.ts';
import type { Scope } from './memory.ts';

export const graphName = z.string().trim().min(1).max(256);
export const attributesSchema = z.record(z.string(), z.unknown()).nullable().refine(v => Buffer.byteLength(JSON.stringify(v)) <= 16384, 'Attributes exceed 16 KiB');
const aliases = z.array(graphName).max(64).transform(v => [...new Set(v)]);
export const entityAddSchema = scopeSchema.extend({ name: graphName, type: graphName.default('Other'), aliases: aliases.default([]), attributes: attributesSchema.optional() });
export const entityIdSchema = scopeSchema.extend({ id: graphName, include_deleted: z.boolean().optional() });
export const entityUpdateSchema = scopeSchema.extend({ id: graphName, updates: z.object({ name: graphName.optional(), type: graphName.optional(), aliases: aliases.optional(), attributes: attributesSchema.optional(), deleted: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0, 'Updates required') });
export const entitySearchSchema = scopeSchema.extend({ query: z.string().trim().max(256).optional(), type: graphName.optional(), include_deleted: z.boolean().optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(100000).default(0) });
export const relationAddSchema = scopeSchema.extend({ source_entity_id: graphName, predicate: graphName, target_entity_id: graphName,
  attributes: attributesSchema.optional(), confidence: z.number().min(0).max(1).default(1), source_memory_id: graphName.nullable().optional(),
  valid_from: timestamp.optional(), valid_to: timestamp.nullable().optional(),
  conflict_strategy: z.enum(['preserve', 'supersede', 'parallel']).default('preserve'), supersedes: graphName.optional(),
});
export const relationSearchSchema = scopeSchema.extend({ source_entity_id: graphName.optional(), target_entity_id: graphName.optional(), predicate: graphName.optional(), source_memory_id: graphName.optional(),
  at: timestamp.optional(), history: z.boolean().default(false), include_deleted: z.boolean().default(false), include_inactive: z.boolean().default(false), include_stale: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(100000).default(0) });
export const relationUpdateSchema = scopeSchema.extend({ id: graphName, updates: z.object({ attributes: attributesSchema.optional(), confidence: z.number().min(0).max(1).optional(),
  status: z.enum(['active', 'inactive', 'conflict']).optional(), source_memory_id:graphName.nullable().optional(), valid_to: timestamp.nullable().optional(), deleted: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0, 'Updates required') });
export const linkSchema = scopeSchema.extend({ memory_id: graphName, entity_id: graphName, role: graphName.default('mentions'), confidence: z.number().min(0).max(1).default(1), unlink: z.boolean().default(false) });
export const neighborsSchema = scopeSchema.extend({ entity_id: graphName, at: timestamp.optional(), direction: z.enum(['out', 'in', 'both']).default('both'),
  max_depth: z.number().int().min(1).max(3).default(1), max_nodes: z.number().int().min(1).max(1000).optional() });
export const pathSchema = neighborsSchema.omit({ entity_id: true }).extend({ source_entity_id: graphName, target_entity_id: graphName });
export const atTimeSchema = relationSearchSchema.omit({ history: true,include_stale:true }).extend({ at: timestamp,include_stale:z.boolean().default(true) });
export type Entity = Scope & { id: string; type: string; name: string; canonical_name: string; aliases: string[]; attributes: Record<string, unknown> | null; created_at: string; updated_at: string; deleted_at: string | null };
export type Relation = Scope & { id: string; source_entity_id: string; predicate: string; target_entity_id: string; attributes: Record<string, unknown> | null; confidence: number;
  source_memory_id: string | null; source_content_hash: string | null; valid_from: string; valid_to: string | null; superseded_by: string | null;
  status: 'active' | 'inactive' | 'conflict' | 'superseded'; created_at: string; updated_at: string; deleted_at: string | null };
export type RelationFilters = z.infer<typeof relationSearchSchema> & Scope;
export type EntityFilters = z.infer<typeof entitySearchSchema> & Scope;
export const canonicalName = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
