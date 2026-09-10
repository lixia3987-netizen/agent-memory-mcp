import { z } from 'zod';

const providerBase = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.url().optional(), model: z.string().trim().min(1).max(256).optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  timeoutMs: z.number().int().min(50).max(120000).default(15000),
  retries: z.number().int().min(0).max(3).default(1),
  circuitFailures: z.number().int().min(1).max(10).default(3),
  circuitCooldownMs: z.number().int().min(100).max(300000).default(30000),
  maxResponseBytes: z.number().int().min(1024).max(16777216).default(4194304),
  allowInsecureHttp: z.boolean().default(false),
}).strict();
export type ProviderConfig = z.infer<typeof providerBase>;
export const embeddingConfigSchema = providerBase.extend({
  dimensions: z.number().int().min(1).max(8192).optional(),
  batchSize: z.number().int().min(1).max(64).default(16),
  maxCandidates: z.number().int().min(1).max(20000).default(5000),
  maxVectorBytes: z.number().int().min(1024).max(134217728).default(33554432),
}).prefault({});
export const llmConfigSchema = providerBase.extend({
  // Job executions across maintenance passes, separate from per-request HTTP retries.
  maxAttempts: z.number().int().min(1).max(100).default(3),
}).prefault({});
export const duplicatesConfigSchema = z.object({
  // Serialized memory candidates and vector BLOBs have separate budgets.
  maxCandidateBytes: z.number().int().min(1024).max(67108864).default(8388608),
}).strict().prefault({});
export const policyConfigSchema = z.object({
  secretDetection: z.boolean().default(true),
  secretAction: z.enum(['reject', 'redact']).default('reject'),
  secretPatterns: z.array(z.string().min(1).max(256)).max(20).default([]),
  rejectTypes: z.array(z.string()).default([]), rejectSources: z.array(z.string()).default([]),
  rejectNamespaces: z.array(z.string()).default([]),
  minimumImportance: z.number().int().min(1).max(10).default(1),
  maxContentBytes: z.number().int().min(1).max(65536).default(65536),
  defaultTtlDays: z.number().positive().max(36500).nullable().default(null),
  duplicateThreshold: z.number().min(0).max(1).default(0.85),
  typeDefaults: z.record(z.string(), z.object({ importance: z.number().int().min(1).max(10).optional(), ttlDays: z.number().positive().max(36500).optional() }).strict()).default({}),
}).strict().prefault({});
export const graphConfigSchema = z.object({ maxNodes: z.number().int().min(1).max(1000).default(200),
  maxEdges: z.number().int().min(1).max(10000).default(2000), maxDepth: z.number().int().min(1).max(3).default(3) }).strict().prefault({});
export const httpConfigSchema = z.object({ enabled: z.boolean().default(false),
  host: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(3210),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('AGENT_MEMORY_HTTP_TOKEN'),
  maxRequestBytes: z.number().int().min(1024).max(16777216).default(12582912),
  maxConcurrentRequests: z.number().int().min(1).max(100).default(20),
  requestTimeoutMs: z.number().int().min(50).max(600000).default(30000),
  headersTimeoutMs: z.number().int().min(50).max(600000).default(10000),
}).strict().prefault({});
