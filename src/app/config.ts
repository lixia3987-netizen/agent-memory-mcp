import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defaultHome, expandPath } from '../shared/paths.ts';
import { AppError, asAppError } from '../shared/errors.ts';
import { embeddingConfigSchema, llmConfigSchema, policyConfigSchema, graphConfigSchema, httpConfigSchema, duplicatesConfigSchema } from '../domain/phase2-config.ts';

const configPath = z.string().refine(value=>value.trim().length>0,'Path must not be blank');
const configSchema = z.object({
  homeDir: configPath, dbPath: configPath, namespace: z.string().trim().min(1).max(256).default('global'),
  project: z.string().trim().min(1).max(256).nullable().default(null),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  busyTimeoutMs: z.number().int().min(1).max(60000).default(5000),
  search: z.object({ defaultLimit: z.number().int().min(1).max(100).default(10), maxLimit: z.number().int().min(1).max(100).default(100),
    importanceBoost: z.number().min(0).max(0.2).default(0.12), recencyBoost: z.number().min(0).max(0.1).default(0.08),
  }).strict().prefault({}),
  imports: z.object({ allowedRoots: z.array(configPath).default([]), maxFileBytes: z.number().int().positive().max(52428800).default(10485760),
    maxFiles: z.number().int().min(1).max(10000).default(1000), maxRecords: z.number().int().min(1).max(100000).default(10000),
  }).strict().prefault({}),
  maxExportBytes: z.number().int().min(1024).max(104857600).default(16777216),
  embedding: embeddingConfigSchema, llm: llmConfigSchema, policy: policyConfigSchema,
  graph: graphConfigSchema, http: httpConfigSchema, duplicates: duplicatesConfigSchema,
}).strict();
export type AppConfig = z.infer<typeof configSchema>;
export type ConfigOverrides = Partial<z.input<typeof configSchema>> & { config?: string };
export function resolveConfig(cli: ConfigOverrides = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const initialHome = expandPath(cli.homeDir ?? env.AGENT_MEMORY_HOME ?? defaultHome(env));
  const configFile = expandPath(cli.config ?? env.AGENT_MEMORY_CONFIG ?? path.join(initialHome, 'config', 'config.json'));
  let file: Record<string, unknown> = {};
  let text: string | undefined;
  try { text=readFileSync(configFile,'utf8'); }
  catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    if (code!=='ENOENT' || cli.config!==undefined || env.AGENT_MEMORY_CONFIG!==undefined) {
      if (code==='EISDIR') throw new AppError('VALIDATION_ERROR','Configuration path must be a file, not a directory.');
      const e=asAppError(error);
      throw new AppError(e.code,'Unable to read configuration file. '+e.message,e.retryable);
    }
  }
  if (text!==undefined) {
    try { file = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new AppError('VALIDATION_ERROR', 'Configuration must be a valid JSON object.'); }
    if (!file || Array.isArray(file) || typeof file !== 'object') throw new AppError('VALIDATION_ERROR', 'Configuration must be an object.');
  }
  const environment = Object.fromEntries(Object.entries({ homeDir: env.AGENT_MEMORY_HOME, dbPath: env.AGENT_MEMORY_DB,
    namespace: env.AGENT_MEMORY_NAMESPACE, project: env.AGENT_MEMORY_PROJECT, logLevel: env.AGENT_MEMORY_LOG_LEVEL }).filter(([, v]) => v !== undefined));
  const { config: _config, ...overrides } = cli;
  const merged = { ...file, ...environment, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) };
  const homeDir = expandPath(configPath.parse(merged.homeDir===undefined ? initialHome : merged.homeDir));
  const dbPath = expandPath(configPath.parse(merged.dbPath===undefined ? path.join(homeDir,'data','memory.db') : merged.dbPath));
  const parsed = configSchema.parse({ ...merged, homeDir, dbPath });
  if (parsed.search.defaultLimit > parsed.search.maxLimit) throw new AppError('VALIDATION_ERROR', 'search.defaultLimit cannot exceed search.maxLimit.');
  if (parsed.http.headersTimeoutMs > parsed.http.requestTimeoutMs) throw new AppError('VALIDATION_ERROR', 'http.headersTimeoutMs cannot exceed http.requestTimeoutMs.');
  try { for (const pattern of parsed.policy.secretPatterns) new RegExp(pattern,'gu'); }
  catch { throw new AppError('VALIDATION_ERROR','A configured secret pattern is not a valid regular expression.'); }
  for (const [label, provider] of [['embedding', parsed.embedding], ['llm', parsed.llm]] as const) {
    if (provider.enabled && (!provider.baseUrl || !provider.model)) throw new AppError('VALIDATION_ERROR', `${label} requires baseUrl and model when enabled.`);
    if (provider.baseUrl) {
      const url = new URL(provider.baseUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new AppError('VALIDATION_ERROR', `${label}.baseUrl must be an HTTP(S) URL without credentials, query or fragment.`);
      if (url.protocol === 'http:' && !loopback && !provider.allowInsecureHttp) throw new AppError('VALIDATION_ERROR', `${label} requires HTTPS outside loopback unless allowInsecureHttp is explicit.`);
    }
  }
  return parsed;
}
