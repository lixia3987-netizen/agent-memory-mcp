import { maintenanceSchema } from '../domain/intelligence.ts';
import type { MemoryService } from './memory-service.ts';
import type { GraphService } from './graph-service.ts';
import type { IntelligenceRepository } from '../repositories/intelligence-repository.ts';
import type { EmbeddingService } from './embedding-service.ts';
import type { EnrichmentService } from './enrichment-service.ts';
import type { DuplicateService } from './duplicate-service.ts';
import { AppError } from '../shared/errors.ts';

export class MaintenanceService {
  private memory: MemoryService;private graph: GraphService;private repository: IntelligenceRepository;private embeddings: EmbeddingService;private enrichment: EnrichmentService;private duplicates: DuplicateService;
  constructor(memory: MemoryService,graph: GraphService,repository: IntelligenceRepository,embeddings: EmbeddingService,enrichment: EnrichmentService,duplicates: DuplicateService) {
    this.memory=memory;this.graph=graph;this.repository=repository;this.embeddings=embeddings;this.enrichment=enrichment;this.duplicates=duplicates;
  }
  stats(input: unknown): Record<string,unknown> {
    const scope=this.memory.scope(input);
    return { scope,...this.memory.repository.stats(scope),...this.graph.stats(scope),...this.repository.stats(scope),embedding_enabled:!!this.embeddings.provider,llm_enabled:!!this.enrichment.provider };
  }
  async run(input: unknown): Promise<unknown> {
    const v=maintenanceSchema.parse(input);const scope=this.memory.scope({ namespace:v.namespace,project:v.project });
    switch (v.action) {
      case 'stats': return this.stats(scope);
      case 'graph-check': return { ...this.graph.consistency(scope),scope };
      case 'expire': return this.memory.repository.transaction(()=>{
        const records=this.repository.expired(scope,v.limit);
        if (!v.dry_run) for (const m of records) this.memory.delete({ ...scope,id:m.id });
        return { dry_run:v.dry_run,expired_count:records.length,ids:records.map(m=>m.id),action:'soft_delete' };
      });
      case 'orphans': return this.graph.cleanupOrphans(scope,v.limit,v.dry_run);
      case 'fts-rebuild':
        if (!v.dry_run) this.memory.repository.transaction(()=>this.repository.rebuildFts());
        return { dry_run:v.dry_run,rebuilt:!v.dry_run,scope:'whole_database' };
      case 'vacuum':
        if (!v.dry_run) this.repository.vacuum();return { dry_run:v.dry_run,vacuumed:!v.dry_run,scope:'whole_database' };
      case 'embeddings':
        return v.dry_run ? { dry_run:true,enabled:!!this.embeddings.provider,limit:v.limit } : this.embeddings.rebuild({ ...scope,limit:v.limit,force:true,after_id:v.after_id });
      case 'enrichment-jobs':
        return v.dry_run ? { dry_run:true,enabled:!!this.enrichment.provider,limit:v.limit } : this.enrichment.work(scope,v.limit);
      case 'duplicates':
        if (!v.id) throw new AppError('VALIDATION_ERROR','Duplicate report requires a target memory id.');
        return this.duplicates.find({ ...scope,id:v.id,limit:Math.min(v.limit,100) });
    }
  }
}
