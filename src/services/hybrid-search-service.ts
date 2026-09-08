import { hybridSchema } from '../domain/intelligence.ts';
import type { Memory, SearchHit } from '../domain/memory.ts';
import type { MemoryService } from './memory-service.ts';
import type { EmbeddingService } from './embedding-service.ts';
import type { GraphService } from './graph-service.ts';
import type { IntelligenceRepository } from '../repositories/intelligence-repository.ts';
import { asAppError } from '../shared/errors.ts';
import { rrf } from './vector-math.ts';

export function searchHit(memory: Memory,score: number): SearchHit {
  const { content,metadata:_metadata,content_hash:_hash,deleted_at:_deleted,...rest }=memory;
  return { ...rest,snippet:content.slice(0,600),score };
}
export class HybridSearchService {
  private memory: MemoryService;private embeddings: EmbeddingService;private graph: GraphService;private repository: IntelligenceRepository;
  constructor(memory: MemoryService,embeddings: EmbeddingService,graph: GraphService,repository: IntelligenceRepository) { this.memory=memory;this.embeddings=embeddings;this.graph=graph;this.repository=repository; }
  async search(input: unknown) {
    const { query,mode,graph_context,...rest }=hybridSchema.parse(input);const filters=this.memory.filters(rest);
    if (mode==='lexical') return this.memory.search({ ...rest,query });
    let semantic: Awaited<ReturnType<EmbeddingService['search']>>;
    try { semantic=await this.embeddings.search(query,filters); }
    catch (error) { const e=asAppError(error);if (e.code!=='PROVIDER_UNAVAILABLE') throw error;
      return { ...this.memory.search({ ...rest,query }),requested_mode:mode,fallback:{ code:e.code,reason:e.message } };
    }
    const lexicalPool=mode==='hybrid' ? this.memory.repository.search(query,{ ...filters,limit:101,offset:0 }) : [];
    const lexical=lexicalPool.slice(0,100);
    const semanticIds=semantic.matches.slice(0,300).map(m=>m.id);const hashes=new Map(semantic.matches.map(m=>[m.id,m.hash]));
    let graphIds: string[]=[];let graphFallback: string | null=null;
    if (mode==='hybrid' && graph_context && !filters.all_projects) {
      try {
        const seeds=this.graph.entitySearch({ namespace:filters.namespace,project:filters.project,query,limit:10 }).entities;
        const entityIds=new Set<string>();
        for (const seed of seeds) for (const e of this.graph.neighbors({ namespace:filters.namespace,project:filters.project,entity_id:seed.id,max_depth:1,max_nodes:Math.min(50,this.memory.config.graph.maxNodes) }).entities) entityIds.add(e.id);
        graphIds=this.graph.linkedMemoryIds([...entityIds],filters,100);
      } catch { graphFallback='Graph context unavailable; lexical and semantic results retained.'; }
    }
    const allIds=[...new Set([...semanticIds,...lexical.map(m=>m.id),...graphIds])];
    const current=this.repository.findFiltered(allIds,filters);const byId=new Map(current.map(m=>[m.id,m]));
    const freshSemantic=semanticIds.filter(id=>byId.get(id)?.content_hash===hashes.get(id));
    const rankings=[freshSemantic,...(mode==='hybrid' ? [lexical.map(m=>m.id),graphIds] : [])];
    const fused=rrf(rankings);const cosines=new Map(semantic.matches.map(m=>[m.id,m.score]));const now=Date.now();
    const scores=[...fused].filter(([id])=>byId.has(id)).map(([id,score])=>{
      const memory=byId.get(id)!; const age=Math.max(0,now-Date.parse(memory.updated_at))/86400000;
      return { id,score:mode==='semantic' ? cosines.get(id)! : score*(1+this.memory.config.search.importanceBoost*memory.importance/10+this.memory.config.search.recencyBoost/(1+age/90)) };
    }).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
    const offset=filters.offset ?? 0;
    return { query,mode,memories:scores.slice(offset,offset+filters.limit!).map(({id,score})=>searchHit(byId.get(id)!,score)),
      candidate_count:scores.length,truncated:semantic.truncated || semantic.matches.length>300 || lexicalPool.length>100 || graphIds.length>=100,dimension_mismatches:semantic.dimension_mismatches,graph_used:graphIds.length>0,graph_fallback:graphFallback };
  }
}
