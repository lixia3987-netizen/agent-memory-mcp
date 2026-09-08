import { embedSchema } from '../domain/intelligence.ts';
import type { Filters } from '../domain/memory.ts';
import type { MemoryService } from './memory-service.ts';
import type { IntelligenceRepository } from '../repositories/intelligence-repository.ts';
import type { EmbeddingProvider } from '../infra/providers/contracts.ts';
import { validateVector } from '../infra/providers/openai-compatible.ts';
import { cosine } from './vector-math.ts';
import { AppError } from '../shared/errors.ts';

export class EmbeddingService {
  readonly provider: EmbeddingProvider | null;
  private memory: MemoryService;private repository: IntelligenceRepository;
  constructor(memory: MemoryService,repository: IntelligenceRepository,provider: EmbeddingProvider | null) { this.memory=memory;this.repository=repository;this.provider=provider; }
  async rebuild(input: unknown) {
    const v=embedSchema.parse(input);const provider=this.provider;
    if (!provider) return { enabled:false,indexed:0,stale:0,model:null };
    const scope=this.memory.scope({ namespace:v.namespace,project:v.project });
    if (v.ids && v.after_id) throw new AppError('VALIDATION_ERROR','Explicit IDs cannot be combined with an indexing cursor.');
    const pool=v.ids ? [...new Set(v.ids)].map(id=>this.memory.get({ ...scope,id })) : this.repository.pendingEmbeddings(scope,provider.id,provider.model,v.limit+1,v.force,v.after_id);
    const candidates=v.ids ? pool : pool.slice(0,v.limit);
    let indexed=0,stale=0;
    for (let i=0;i<candidates.length;i+=this.memory.config.embedding.batchSize) {
      const batch=candidates.slice(i,i+this.memory.config.embedding.batchSize).filter(m=>m.expires_at===null || Date.parse(m.expires_at)>Date.now());
      if (!batch.length) continue;
      const vectors=await provider.embed(batch.map(m=>m.content));
      if (vectors.length!==batch.length) throw new AppError('PROVIDER_UNAVAILABLE','Embedding provider returned the wrong batch size.');
      const dimensions=provider.dimensions() || vectors[0]!.length;
      vectors.forEach(vector=>validateVector(vector,dimensions));
      this.memory.repository.transaction(()=>batch.forEach((m,n)=>{
        const saved=this.repository.saveEmbedding({ memory_id:m.id,provider:provider.id,model:provider.model,dimensions,vector:vectors[n]!,content_hash:m.content_hash,created_at:new Date().toISOString() },scope);
        if (saved) indexed++;else stale++;
      }));
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    return { enabled:true,indexed,stale,model:provider.model,processed:candidates.length,next_cursor:!v.ids && pool.length>v.limit ? candidates.at(-1)!.id : null };
  }
  async search(query: string,filters: Filters) {
    const provider=this.provider;
    if (!provider) throw new AppError('PROVIDER_UNAVAILABLE','Embedding provider is disabled.');
    const cfg=this.memory.config.embedding;
    const pool=this.repository.vectors(filters,provider.id,provider.model,cfg.maxCandidates,cfg.maxVectorBytes);
    if (!pool.embeddings.length) throw new AppError('PROVIDER_UNAVAILABLE','No current embeddings are indexed for this scope. Run memory_reindex or maintenance embeddings.');
    const vectors=await provider.embed([query]);
    if (vectors.length!==1) throw new AppError('PROVIDER_UNAVAILABLE','Embedding provider returned an invalid query batch.');
    const vector=vectors[0]!;validateVector(vector,provider.dimensions() || vector.length);
    const compatible=pool.embeddings.filter(e=>e.dimensions===vector.length);
    if (!compatible.length) throw new AppError('PROVIDER_UNAVAILABLE','Indexed dimensions differ from the provider. Rebuild embeddings.');
    return { matches:compatible.map(e=>({ id:e.memory_id,score:cosine(vector,e.vector),hash:e.content_hash })).filter(x=>x.score>0).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)),
      truncated:pool.truncated,dimension_mismatches:pool.embeddings.length-compatible.length };
  }
}
