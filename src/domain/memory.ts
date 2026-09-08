import { z } from 'zod';

const name = z.string().trim().min(1).max(256);
export const timestamp = z.iso.datetime({ offset: true }).transform(v => new Date(v).toISOString());
export const scopeSchema = z.object({ namespace: name.optional(), project: name.nullable().optional() }).strict();
export const mutableSchema = z.object({
  project: name.nullable().optional(),
  type: name.optional(),
  title: z.string().trim().max(512).nullable().optional(),
  content: z.string().min(1).refine(v => v.trim().length > 0, 'Content cannot be blank')
    .refine(v => Buffer.byteLength(v, 'utf8') <= 65536, 'Content exceeds 64 KiB').optional(),
  tags: z.array(name).max(64).transform(v => [...new Set(v)]).optional(),
  source: name.optional(),
  importance: z.number().int().min(1).max(10).optional(),
  expires_at: timestamp.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().refine(v => Buffer.byteLength(JSON.stringify(v)) <= 16384, 'Metadata exceeds 16 KiB').optional(),
}).strict();
export const addSchema = mutableSchema.extend({ namespace: name.optional(), content: mutableSchema.shape.content.unwrap() });
export const filterSchema = scopeSchema.extend({
  all_projects: z.boolean().optional(),
  type: name.optional(), source: name.optional(), tags: z.array(name).max(64).optional(),
  tag: name.optional(), importance_min: z.number().int().min(1).max(10).optional(),
  created_after: timestamp.optional(), created_before: timestamp.optional(),
  include_expired: z.boolean().optional(), include_deleted: z.boolean().optional(),
});
export const listSchema = filterSchema.extend({
  limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000000).optional(),
  sort: z.enum(['updated_desc', 'created_desc', 'created_asc', 'importance_desc']).optional(),
});
export const searchSchema = listSchema.extend({ query: z.string().trim().min(1).max(1024) });
// Physical deletion is exposed only through the explicit CLI/service operation.
export const purgeSchema = listSchema.extend({ before: timestamp, confirmed: z.literal(true) });
export const idSchema = scopeSchema.extend({ id: name, include_deleted: z.boolean().optional() });
export const updateSchema = scopeSchema.extend({ id: name, updates: mutableSchema.refine(v => Object.keys(v).length > 0, 'At least one update is required') });
export const importSchema = scopeSchema.extend({
  path: z.string().min(1).optional(), data: z.string().max(10485760).optional(),
  format: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  dry_run: z.boolean().default(true), conflict: z.enum(['skip', 'update', 'copy']).default('skip'),
  backup: z.boolean().default(false),
}).refine(v => Number(v.path !== undefined) + Number(v.data !== undefined) === 1, 'Specify exactly one of path or data');
export const exportSchema = filterSchema.extend({ format: z.enum(['json', 'markdown']).default('json') });
export const importRecordSchema = addSchema.extend({
  id: name.optional(), created_at: timestamp.optional(), updated_at: timestamp.optional(),
  deleted_at: timestamp.nullable().optional(), content_hash: z.string().optional(), expired: z.boolean().optional(),
});

export type Scope = { namespace: string; project: string | null };
export type AddInput = z.infer<typeof addSchema>;
export type UpdateInput = z.infer<typeof mutableSchema>;
export type Filters = z.infer<typeof listSchema> & Scope;
export type ImportRecord = z.infer<typeof importRecordSchema>;
export type ImportInput = z.input<typeof importSchema>;
export type Memory = Scope & {
  id: string; type: string; title: string | null; content: string; tags: string[]; source: string;
  importance: number; created_at: string; updated_at: string; expires_at: string | null;
  deleted_at: string | null; content_hash: string; metadata: Record<string, unknown> | null;
};
export type SearchHit = Omit<Memory, 'content' | 'metadata' | 'content_hash' | 'deleted_at'> & { snippet: string; score: number };
