import { randomUUID } from 'node:crypto';
import { entityAddSchema, entityIdSchema, entityUpdateSchema, entitySearchSchema, relationAddSchema, relationUpdateSchema, relationSearchSchema,
  linkSchema, neighborsSchema, pathSchema, atTimeSchema, canonicalName, attributesSchema } from '../domain/graph.ts';
import type { Entity, Relation } from '../domain/graph.ts';
import type { Filters, Scope } from '../domain/memory.ts';
import type { GraphRepository } from '../repositories/graph-repository.ts';
import type { MemoryService } from './memory-service.ts';
import { AppError } from '../shared/errors.ts';

export class GraphService {
  private readonly repository: GraphRepository;
  private memory: MemoryService;
  constructor(repository: GraphRepository, memory: MemoryService) { this.repository = repository; this.memory = memory; }
  entityGet(input: unknown): Entity {
    const v = entityIdSchema.parse(input); const result = this.repository.findEntity(v.id, this.memory.scope({ namespace: v.namespace, project: v.project }), v.include_deleted);
    if (!result) throw new AppError('NOT_FOUND', 'Entity not found in the selected scope.'); return result;
  }
  entityAdd(input: unknown) {
    const v = entityAddSchema.parse(input); const scope = this.memory.scope({ namespace: v.namespace, project: v.project });
    return this.memory.repository.transaction(() => {
      const old = this.repository.identity(scope,v.type,canonicalName(v.name));
      if (old) return { entity: old, deduplicated: true };
      const now = new Date().toISOString();
      const entity: Entity = { ...scope,id: randomUUID(),type:v.type,name:v.name,canonical_name:canonicalName(v.name),aliases:v.aliases,attributes:v.attributes ?? null,created_at:now,updated_at:now,deleted_at:null };
      this.memory.policy.checkSecrets(JSON.stringify(entity));
      this.repository.saveEntity(entity,true); return { entity, deduplicated: false };
    });
  }
  entityUpdate(input: unknown): Entity {
    const v = entityUpdateSchema.parse(input);
    return this.memory.repository.transaction(() => {
      const old = this.entityGet({ id:v.id, namespace:v.namespace, project:v.project, include_deleted:true });
      const { deleted, ...updates } = v.updates;
      const next = { ...old,...updates,updated_at:new Date().toISOString(),deleted_at:deleted === undefined ? old.deleted_at : deleted ? new Date().toISOString() : null };
      next.canonical_name = canonicalName(next.name);
      if (!next.deleted_at && this.repository.identity(next,next.type,next.canonical_name,next.id)) throw new AppError('CONFLICT','Entity identity is already in use.');
      this.memory.policy.checkSecrets(JSON.stringify(next)); this.repository.saveEntity(next,false); return next;
    });
  }
  entitySearch(input: unknown) {
    const v = entitySearchSchema.parse(input); return { entities: this.repository.entities({ ...v,...this.memory.scope({ namespace:v.namespace,project:v.project }) }) };
  }
  relationAdd(input: unknown) {
    const v = relationAddSchema.parse(input); const scope = this.memory.scope({ namespace:v.namespace,project:v.project });
    return this.memory.repository.transaction(() => {
      this.entityGet({ ...scope,id:v.source_entity_id }); this.entityGet({ ...scope,id:v.target_entity_id });
      const source = v.source_memory_id ? this.memory.get({ ...scope,id:v.source_memory_id }) : null;
      if (source?.expired) throw new AppError('CONFLICT','Cannot attach a new fact to expired memory.');
      const now = new Date().toISOString();
      const r: Relation = { ...scope,id:randomUUID(),source_entity_id:v.source_entity_id,predicate:v.predicate,target_entity_id:v.target_entity_id,
        attributes:v.attributes ?? null,confidence:v.confidence,source_memory_id:source?.id ?? null,source_content_hash:source?.content_hash ?? null,
        valid_from:v.valid_from ?? now,valid_to:v.valid_to ?? null,superseded_by:null,status:'active',created_at:now,updated_at:now,deleted_at:null };
      if (r.valid_to !== null && r.valid_to <= r.valid_from) throw new AppError('VALIDATION_ERROR','valid_to must follow valid_from.');
      if ((v.conflict_strategy === 'supersede') !== !!v.supersedes) throw new AppError('VALIDATION_ERROR','supersede requires exactly one supersedes relation ID.');
      this.memory.policy.checkSecrets(JSON.stringify(r));
      const conflicts = this.repository.conflicts(r);
      if (conflicts.length > 1000) throw new AppError('CONFLICT','Too many overlapping facts. Resolve existing conflicts first.');
      if (v.supersedes) {
        const old = this.repository.findRelation(v.supersedes,scope);
        if (!old || old.source_entity_id !== r.source_entity_id || old.predicate !== r.predicate || old.superseded_by || old.status === 'inactive') throw new AppError('CONFLICT','Superseded fact must be a current fact with the same source and predicate.');
        if (r.valid_from <= old.valid_from || (old.valid_to !== null && r.valid_from >= old.valid_to)) throw new AppError('CONFLICT','New fact must take effect strictly inside the old validity interval.');
        // Insert first so the superseded_by foreign key is valid in this transaction.
        this.repository.saveRelation(r,true);
        this.repository.saveRelation({ ...old,valid_to:r.valid_from,superseded_by:r.id,status:'superseded',updated_at:now },false);
        for (const conflict of conflicts.filter(c => c.id !== old.id)) this.markConflict(conflict,r,now);
        this.repository.saveRelation(r,false);
      } else {
        if (v.conflict_strategy === 'preserve') for (const conflict of conflicts) this.markConflict(conflict,r,now);
        this.repository.saveRelation(r,true);
      }
      return { relation:r,conflicts: v.conflict_strategy === 'parallel' ? [] : conflicts.filter(c => c.id !== v.supersedes).map(c => c.id) };
    });
  }
  private markConflict(old: Relation, fresh: Relation, now: string): void {
    const a = new Set(Array.isArray(old.attributes?.conflict_with) ? old.attributes.conflict_with.filter(x => typeof x === 'string') as string[] : []); a.add(fresh.id);
    const b = new Set(Array.isArray(fresh.attributes?.conflict_with) ? fresh.attributes.conflict_with as string[] : []); b.add(old.id);
    const oldAttributes = attributesSchema.parse({ ...old.attributes,conflict_with:[...a] });
    fresh.attributes = attributesSchema.parse({ ...fresh.attributes,conflict_with:[...b] }); fresh.status='conflict'; fresh.confidence=Math.min(fresh.confidence,0.5);
    this.repository.saveRelation({ ...old,attributes:oldAttributes,status:old.superseded_by ? 'superseded' : 'conflict',confidence:Math.min(old.confidence,0.5),updated_at:now },false);
  }
  relationSearch(input: unknown) {
    const v = relationSearchSchema.parse(input); const scope = this.memory.scope({ namespace:v.namespace,project:v.project });
    const at = v.at ?? new Date().toISOString();
    return { at,relations:this.repository.relations({ ...v,...scope,at,include_stale:v.include_stale ?? (v.at!==undefined) }).map(r => ({ ...r,active:r.deleted_at === null && r.status !== 'inactive' && r.valid_from <= at && (r.valid_to === null || r.valid_to > at) })) };
  }
  atTime(input: unknown) { return this.relationSearch({ ...atTimeSchema.parse(input),history:false }); }
  relationUpdate(input: unknown): Relation {
    const v = relationUpdateSchema.parse(input); const scope = this.memory.scope({ namespace:v.namespace,project:v.project });
    return this.memory.repository.transaction(() => {
      const old = this.repository.findRelation(v.id,scope,true); if (!old) throw new AppError('NOT_FOUND','Relation not found in the selected scope.');
      if (old.superseded_by && ('valid_to' in v.updates || 'status' in v.updates)) throw new AppError('CONFLICT','A superseded interval cannot be reopened. Create another temporal fact.');
      const { deleted,...updates } = v.updates;
      const next: Relation = { ...old,...updates,updated_at:new Date().toISOString(),deleted_at:deleted === undefined ? old.deleted_at : deleted ? new Date().toISOString() : null };
      if (updates.source_memory_id!==undefined) {
        const source=updates.source_memory_id===null ? null : this.memory.get({ ...scope,id:updates.source_memory_id });
        if (source?.expired) throw new AppError('CONFLICT','Cannot attach a fact to expired memory.');
        next.source_content_hash=source?.content_hash ?? null;
      }
      if (next.valid_to !== null && next.valid_to <= next.valid_from) throw new AppError('VALIDATION_ERROR','valid_to must follow valid_from.');
      if (!next.deleted_at) { this.entityGet({ ...scope,id:next.source_entity_id }); this.entityGet({ ...scope,id:next.target_entity_id }); }
      this.memory.policy.checkSecrets(JSON.stringify(next));
      if (!next.deleted_at && next.status!=='inactive' && !next.superseded_by &&
        ('valid_to' in updates || 'status' in updates || deleted===false || old.status==='conflict')) {
        const conflicts=this.repository.conflicts(next);
        if (conflicts.length>1000) throw new AppError('CONFLICT','Too many overlapping facts. Resolve existing conflicts first.');
        for (const conflict of conflicts) this.markConflict(conflict,next,next.updated_at);
      }
      this.repository.saveRelation(next,false); return next;
    });
  }
  link(input: unknown) {
    const v = linkSchema.parse(input); const scope = this.memory.scope({ namespace:v.namespace,project:v.project });
    return this.memory.repository.transaction(() => {
      const memory = this.memory.get({ ...scope,id:v.memory_id,include_deleted:v.unlink });
      this.entityGet({ ...scope,id:v.entity_id,include_deleted:v.unlink });
      if (memory.expired && !v.unlink) throw new AppError('CONFLICT','Cannot link expired memory.');
      this.repository.link(v.memory_id,v.entity_id,scope,v.role,v.confidence,v.unlink); return { linked:!v.unlink };
    });
  }
  linkedMemoryIds(entityIds: string[], filters: Filters, limit: number): string[] {
    return this.repository.links(entityIds,filters,limit);
  }
  stats(input: unknown): Record<string,number> { return this.repository.stats(this.memory.scope(input)); }
  consistency(input: unknown) { return this.repository.consistency(this.memory.scope(input)); }
  cleanupOrphans(scope: Scope, limit: number, dryRun: boolean) {
    return this.memory.repository.transaction(()=>{
      const entities=this.repository.orphanEntities(scope,limit);
      if (!dryRun) for (const e of entities) this.entityUpdate({ ...scope,id:e.id,updates:{ deleted:true } });
      return { dry_run:dryRun,orphan_count:entities.length,ids:entities.map(e=>e.id),action:'soft_delete' };
    });
  }
  neighbors(input: unknown) {
    const v = neighborsSchema.parse(input); const scope = this.memory.scope({ namespace:v.namespace,project:v.project });
    const root = this.entityGet({ ...scope,id:v.entity_id }); const limits = this.memory.config.graph;
    if (v.max_depth > limits.maxDepth || (v.max_nodes ?? limits.maxNodes) > limits.maxNodes) throw new AppError('VALIDATION_ERROR','Traversal exceeds configured limits.');
    const maxNodes = v.max_nodes ?? limits.maxNodes; const nodes = new Map([[root.id,root]]); const edges = new Map<string,Relation>();
    let frontier = [root.id]; let truncated = false; const at = v.at ?? new Date().toISOString();
    for (let depth=0; depth<v.max_depth && frontier.length; depth++) {
      const found = this.repository.edges(frontier,scope,at,v.direction,limits.maxEdges+1,v.include_stale ?? (v.at!==undefined));
      if (found.length > limits.maxEdges) truncated=true;
      const next: string[] = [];
      for (const edge of found) {
        if (edges.has(edge.id)) continue;
        if (edges.size >= limits.maxEdges) { truncated=true; break; }
        const missing = [edge.source_entity_id,edge.target_entity_id].filter(id => !nodes.has(id));
        if (nodes.size + new Set(missing).size > maxNodes) { truncated=true; continue; }
        for (const id of missing) { if (!nodes.has(id)) { nodes.set(id,this.entityGet({ ...scope,id })); next.push(id); } }
        edges.set(edge.id,edge);
      }
      frontier=next;
    }
    return { entities:[...nodes.values()],relations:[...edges.values()],truncated,at };
  }
  path(input: unknown) {
    const v = pathSchema.parse(input); this.entityGet({ namespace:v.namespace,project:v.project,id:v.target_entity_id });
    const { source_entity_id,target_entity_id,...options } = v;
    const graph = this.neighbors({ ...options,entity_id:source_entity_id });
    const queue = [source_entity_id]; const parents = new Map<string,{ previous:string; edge:string }>(); const visited = new Set(queue);
    while (queue.length) {
      const id = queue.shift()!; if (id===target_entity_id) break;
      for (const edge of graph.relations) {
        const next = edge.source_entity_id===id && v.direction!=='in' ? edge.target_entity_id : edge.target_entity_id===id && v.direction!=='out' ? edge.source_entity_id : null;
        if (next && !visited.has(next)) { visited.add(next);parents.set(next,{ previous:id,edge:edge.id });queue.push(next); }
      }
    }
    const ids: string[] = []; const relations: string[] = [];
    if (visited.has(target_entity_id)) { let id=target_entity_id; ids.push(id); while (id!==source_entity_id) { const p=parents.get(id)!;relations.push(p.edge);id=p.previous;ids.push(id); } }
    if (relations.length > v.max_depth) return { found:false,entity_ids:[],relation_ids:[],truncated:graph.truncated };
    return { found:ids.length>0,entity_ids:ids.reverse(),relation_ids:relations.reverse(),truncated:graph.truncated };
  }
}
