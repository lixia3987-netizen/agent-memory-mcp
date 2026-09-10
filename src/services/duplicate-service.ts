import { duplicatesSchema, mergeSchema } from '../domain/intelligence.ts';
import type { MemoryService } from './memory-service.ts';
import type { IntelligenceRepository } from '../repositories/intelligence-repository.ts';
import type { GraphRepository } from '../repositories/graph-repository.ts';
import type { EmbeddingProvider } from '../infra/providers/contracts.ts';
import { textSimilarity, cosine } from './vector-math.ts';
import { sha256 } from '../shared/hash.ts';
import { AppError } from '../shared/errors.ts';
import { mutableSchema } from '../domain/memory.ts';

export class DuplicateService {
  private memory: MemoryService;private repository: IntelligenceRepository;private graph: GraphRepository;private provider: EmbeddingProvider | null;
  constructor(memory: MemoryService,repository: IntelligenceRepository,graph: GraphRepository,provider: EmbeddingProvider | null) { this.memory=memory;this.repository=repository;this.graph=graph;this.provider=provider; }
  find(input: unknown) {
    const v=duplicatesSchema.parse(input);const scope=this.memory.scope({ namespace:v.namespace,project:v.project });
    const target=this.memory.get({ ...scope,id:v.id });
    const filters=this.memory.filters(scope);const pool=this.repository.candidates(filters,v.max_candidates,this.memory.config.duplicates.maxCandidateBytes);
    let vectorTruncated=false;
    const semantic=new Map<string,number>();let fallback: string | null=null;
    if (v.mode!=='text') {
      if (this.provider) {
        const vectors=this.repository.vectors(filters,this.provider.id,this.provider.model,this.memory.config.embedding.maxCandidates,this.memory.config.embedding.maxVectorBytes);
        vectorTruncated=vectors.truncated;
        const own=vectors.embeddings.find(e=>e.memory_id===target.id);
        if (own) for (const vector of vectors.embeddings) semantic.set(vector.memory_id,cosine(own.vector,vector.vector));
        else fallback='Target has no current embedding; using text similarity.';
      } else fallback='Embedding provider is disabled; using text similarity.';
    }
    const mode=v.mode==='text' || fallback ? 'text' : v.mode;
    const threshold=v.threshold ?? this.memory.config.policy.duplicateThreshold;
    const candidates=pool.memories.filter(m=>m.id!==target.id).map(m=>{
      const text=textSimilarity(target.content,m.content);const semanticScore=semantic.get(m.id) ?? null;
      const score=mode==='semantic' ? semanticScore ?? -1 : mode==='hybrid' ? Math.max(text,semanticScore ?? -1) : text;
      return { id:m.id,title:m.title,source:m.source,score,text_similarity:text,semantic_similarity:semanticScore,content_hash:m.content_hash };
    }).filter(c=>c.score>=threshold).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,v.limit);
    return { target_id:target.id,mode,candidates,scanned:pool.memories.length,truncated:pool.truncated || vectorTruncated,
      text_truncated:pool.truncated,vector_truncated:vectorTruncated,fallback,destructive_changes:false };
  }
  merge(input: unknown) {
    const v=mergeSchema.parse(input);const scope=this.memory.scope({ namespace:v.namespace,project:v.project });
    const ids=[...new Set(v.source_ids)].sort();
    if (ids.includes(v.target_id)) throw new AppError('VALIDATION_ERROR','Target cannot also be a merge source.');
    return this.memory.repository.transaction(()=>{
      const { expired:targetExpired,...target }=this.memory.get({ ...scope,id:v.target_id });
      const sources=ids.map(id=>{ const {expired,...memory}=this.memory.get({ ...scope,id });if (expired) throw new AppError('CONFLICT','Merge sources must be active.');return memory; });
      if (targetExpired) throw new AppError('CONFLICT','Merge target must be active.');
      const combinedContent=[target.content,...sources.map(m=>m.content)].join('\n\n---\n\n');
      const content=v.content ?? combinedContent;
      const tags=[...new Set([...(target.tags ?? []),...sources.flatMap(m=>m.tags)])];
      const previous=Array.isArray(target.metadata?.merge_sources) ? target.metadata.merge_sources : [];
      const updates=mutableSchema.parse({ content,title:v.title===undefined ? target.title : v.title,tags,
        metadata:{ ...target.metadata,merge_sources:[...previous,...sources.map(m=>({ id:m.id,source:m.source,created_at:m.created_at }))] } });
      const proposed=this.memory.policy.apply({ ...target,...updates },false);
      const token=sha256(JSON.stringify({ target,sources,content:proposed.content,title:proposed.title,tags:proposed.tags,metadata:proposed.metadata }));
      if (v.dry_run) return { dry_run:true,target_id:target.id,source_ids:ids,proposed:{ title:proposed.title,content:proposed.content,tags:proposed.tags },proposal_token:token };
      if (v.proposal_token!==token) throw new AppError('CONFLICT','Merge proposal is missing or stale. Preview again and pass its proposal_token.');
      for (const source of sources) { this.repository.saveMerge(target,source);this.memory.delete({ ...scope,id:source.id }); }
      const result=this.memory.update({ ...scope,id:target.id,updates });
      // Only an unchanged concatenation retains the evidence supporting current facts.
      // Custom content or policy redaction requires explicit review/re-enrichment.
      const preserveEvidence=result.content===combinedContent;
      for (const source of sources) this.graph.mergeLinks(target.id,source.id,result.content_hash,scope,preserveEvidence ? source.content_hash : null);
      this.graph.mergeLinks(target.id,target.id,result.content_hash,scope,preserveEvidence ? target.content_hash : null);
      this.memory.repository.audit(result,'merge');
      return { dry_run:false,memory:result,merged_ids:ids,originals_retained:true };
    });
  }
}
