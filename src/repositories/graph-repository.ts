import type { Entity, Relation, EntityFilters, RelationFilters } from '../domain/graph.ts';
import type { Scope, Filters } from '../domain/memory.ts';

export interface GraphRepository {
  findEntity(id: string, scope: Scope, includeDeleted?: boolean): Entity | null;
  identity(scope: Scope, type: string, canonical: string, excludeId?: string): Entity | null;
  saveEntity(entity: Entity, insert: boolean): void;
  entities(filters: EntityFilters): Entity[];
  findRelation(id: string, scope: Scope, includeDeleted?: boolean): Relation | null;
  saveRelation(relation: Relation, insert: boolean): void;
  relations(filters: RelationFilters): Relation[];
  conflicts(relation: Relation): Relation[];
  edges(ids: string[], scope: Scope, at: string, direction: 'in' | 'out' | 'both', limit: number, includeStale?:boolean): Relation[];
  link(memoryId: string, entityId: string, scope: Scope, role: string, confidence: number, unlink?: boolean): void;
  links(entityIds: string[], filters: Filters, limit: number): string[];
  mergeLinks(targetId: string, sourceId: string, contentHash: string, scope: Scope): void;
  stats(scope: Scope): Record<string, number>;
  consistency(scope: Scope): { invalid_relations: number; invalid_links: number };
  orphanEntities(scope: Scope, limit: number): Entity[];
}
