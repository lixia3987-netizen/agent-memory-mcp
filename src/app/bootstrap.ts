import type { ConfigOverrides } from './config.ts';
import { resolveConfig } from './config.ts';
import { openDatabase, databaseInfo, probeFts } from '../infra/sqlite/database.ts';
import { SqliteMemoryRepository } from '../infra/sqlite/memory-repository.ts';
import { MemoryService } from '../services/memory-service.ts';
import { ImportService } from '../services/import-service.ts';
import { ExportService } from '../services/export-service.ts';
import { BackupService } from '../services/backup-service.ts';
import { createLogger } from '../infra/logging/logger.ts';
import { SqliteGraphRepository } from '../infra/sqlite/graph-repository.ts';
import { SqliteIntelligenceRepository } from '../infra/sqlite/intelligence-repository.ts';
import { GraphService } from '../services/graph-service.ts';
import { EmbeddingService } from '../services/embedding-service.ts';
import { HybridSearchService } from '../services/hybrid-search-service.ts';
import { DuplicateService } from '../services/duplicate-service.ts';
import { EnrichmentService } from '../services/enrichment-service.ts';
import { MaintenanceService } from '../services/maintenance-service.ts';
import { OpenAICompatibleEmbeddingProvider, OpenAICompatibleLlmProvider } from '../infra/providers/openai-compatible.ts';
import type { EmbeddingProvider, LlmProvider } from '../infra/providers/contracts.ts';

export async function bootstrap(overrides: ConfigOverrides = {},providers: { embedding?:EmbeddingProvider;llm?:LlmProvider } = {}) {
  const config = resolveConfig(overrides);
  const db = await openDatabase(config);
  const repository = new SqliteMemoryRepository(db, config);
  const memory = new MemoryService(repository, config);
  const backups = new BackupService(db, config);
  const intelligence=new SqliteIntelligenceRepository(db);
  const graphRepository=new SqliteGraphRepository(db);
  const graph=new GraphService(graphRepository,memory);
  const embeddingProvider=providers.embedding ?? (config.embedding.enabled ? new OpenAICompatibleEmbeddingProvider(config.embedding) : null);
  const llmProvider=providers.llm ?? (config.llm.enabled ? new OpenAICompatibleLlmProvider(config.llm) : null);
  const embeddings=new EmbeddingService(memory,intelligence,embeddingProvider);
  const hybrid=new HybridSearchService(memory,embeddings,graph,intelligence);
  const duplicates=new DuplicateService(memory,intelligence,graphRepository,embeddingProvider);
  const enrichment=new EnrichmentService(memory,graph,intelligence,llmProvider);
  const maintenance=new MaintenanceService(memory,graph,intelligence,embeddings,enrichment,duplicates);
  let closed = false;
  return {
    config, memory, imports: new ImportService(memory, () => backups.create()), exports: new ExportService(memory), backups,
    graph,embeddings,hybrid,duplicates,enrichment,maintenance,intelligence,
    log: createLogger(config.logLevel),
    doctor: () => {
      repository.transaction(() => { db.exec('CREATE TABLE __doctor_write_check(value INTEGER); INSERT INTO __doctor_write_check VALUES(1);'); }, true);
      const capabilities=probeFts(db);
      return { ok: capabilities.fts5 && capabilities.trigram, node: process.version, platform: process.platform, dbPath: config.dbPath,
        writable: true, ...capabilities, ...databaseInfo(db), dbBytes: backups.size() };
    },
    close: () => { if (!closed) { closed = true; db.close(); } },
  };
}
export type Application = Awaited<ReturnType<typeof bootstrap>>;
