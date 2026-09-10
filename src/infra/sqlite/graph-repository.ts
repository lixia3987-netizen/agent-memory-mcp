import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Entity, Relation, EntityFilters, RelationFilters } from '../../domain/graph.ts';
import { canonicalName } from '../../domain/graph.ts';
import type { Scope, Filters } from '../../domain/memory.ts';
import type { GraphRepository } from '../../repositories/graph-repository.ts';
import { memoryWhere } from './memory-filters.ts';
import { transaction } from './transaction.ts';
import { AppError } from '../../shared/errors.ts';

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(Number(v)).toISOString();
const nullableIso = (v: unknown): string | null => v === null ? null : iso(v);
const millis = (v: string | null): number | null => v === null ? null : Date.parse(v);
const json = (v: unknown): Record<string, unknown> | null => v === null ? null : JSON.parse(String(v)) as Record<string, unknown>;
const entitySelect = `SELECT e.*,coalesce((SELECT json_group_array(alias) FROM (SELECT alias FROM entity_aliases a WHERE a.entity_id=e.id ORDER BY a.rowid)),'[]') AS aliases_json FROM entities e`;
function entity(row: Row): Entity {
  return { id: String(row.id), namespace: String(row.namespace), project: row.project === null ? null : String(row.project),
    type: String(row.type), name: String(row.name), canonical_name: String(row.canonical_name), attributes: json(row.attributes_json),
    aliases: JSON.parse(String(row.aliases_json)) as string[], created_at: iso(row.created_at), updated_at: iso(row.updated_at), deleted_at: nullableIso(row.deleted_at) };
}
function relation(row: Row): Relation {
  return { id: String(row.id), namespace: String(row.namespace), project: row.project === null ? null : String(row.project), source_entity_id: String(row.source_entity_id),
    predicate: String(row.predicate), target_entity_id: String(row.target_entity_id), attributes: json(row.attributes_json), confidence: Number(row.confidence),
    source_memory_id: row.source_memory_id === null ? null : String(row.source_memory_id), source_content_hash: row.source_content_hash === null ? null : String(row.source_content_hash),
    valid_from: iso(row.valid_from), valid_to: nullableIso(row.valid_to), superseded_by: row.superseded_by === null ? null : String(row.superseded_by),
    status: row.status as Relation['status'], created_at: iso(row.created_at), updated_at: iso(row.updated_at), deleted_at: nullableIso(row.deleted_at) };
}
export class SqliteGraphRepository implements GraphRepository {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  findEntity(id: string, scope: Scope, includeDeleted = false): Entity | null {
    const row = this.db.prepare(`${entitySelect} WHERE e.id=? AND e.namespace=? AND e.project IS ? ${includeDeleted ? '' : 'AND e.deleted_at IS NULL'}`).get(id, scope.namespace, scope.project);
    return row ? entity(row) : null;
  }
  identity(scope: Scope, type: string, canonical: string, excludeId = ''): Entity | null {
    const row = this.db.prepare(`${entitySelect} WHERE e.namespace=? AND e.project IS ? AND e.type=? AND e.canonical_name=? AND e.id<>? AND e.deleted_at IS NULL`).get(scope.namespace, scope.project, type, canonical, excludeId);
    return row ? entity(row) : null;
  }
  saveEntity(e: Entity, insert: boolean): void {
    const values: SQLInputValue[] = [e.namespace, e.project, e.type, e.name, e.canonical_name, e.attributes === null ? null : JSON.stringify(e.attributes), millis(e.created_at), millis(e.updated_at), millis(e.deleted_at), e.id];
    this.db.prepare(insert ? 'INSERT INTO entities(namespace,project,type,name,canonical_name,attributes_json,created_at,updated_at,deleted_at,id) VALUES(?,?,?,?,?,?,?,?,?,?)'
      : 'UPDATE entities SET namespace=?,project=?,type=?,name=?,canonical_name=?,attributes_json=?,created_at=?,updated_at=?,deleted_at=? WHERE id=?').run(...values);
    this.db.prepare('DELETE FROM entity_aliases WHERE entity_id=?').run(e.id);
    const statement = this.db.prepare('INSERT OR IGNORE INTO entity_aliases(entity_id,alias,normalized_alias) VALUES(?,?,?)');
    for (const alias of e.aliases) statement.run(e.id, alias, canonicalName(alias));
  }
  entities(f: EntityFilters): Entity[] {
    const clauses = ['e.namespace=?', 'e.project IS ?']; const params: SQLInputValue[] = [f.namespace, f.project];
    if (!f.include_deleted) clauses.push('e.deleted_at IS NULL');
    if (f.type) { clauses.push('e.type=?'); params.push(f.type); }
    if (f.query) { clauses.push('(instr(e.canonical_name,?)>0 OR EXISTS(SELECT 1 FROM entity_aliases a WHERE a.entity_id=e.id AND instr(a.normalized_alias,?)>0))'); params.push(canonicalName(f.query), canonicalName(f.query)); }
    return this.db.prepare(`${entitySelect} WHERE ${clauses.join(' AND ')} ORDER BY e.canonical_name,e.id LIMIT ? OFFSET ?`).all(...params, f.limit, f.offset).map(entity);
  }
  findRelation(id: string, scope: Scope, includeDeleted = false): Relation | null {
    const row = this.db.prepare(`SELECT * FROM relations WHERE id=? AND namespace=? AND project IS ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id, scope.namespace, scope.project);
    return row ? relation(row) : null;
  }
  saveRelation(r: Relation, insert: boolean): void {
    const values: SQLInputValue[] = [r.namespace,r.project,r.source_entity_id,r.predicate,r.target_entity_id,r.attributes === null ? null : JSON.stringify(r.attributes),r.confidence,
      r.source_memory_id,r.source_content_hash,millis(r.valid_from),millis(r.valid_to),r.superseded_by,r.status,millis(r.created_at),millis(r.updated_at),millis(r.deleted_at),r.id];
    this.db.prepare(insert ? 'INSERT INTO relations(namespace,project,source_entity_id,predicate,target_entity_id,attributes_json,confidence,source_memory_id,source_content_hash,valid_from,valid_to,superseded_by,status,created_at,updated_at,deleted_at,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      : 'UPDATE relations SET namespace=?,project=?,source_entity_id=?,predicate=?,target_entity_id=?,attributes_json=?,confidence=?,source_memory_id=?,source_content_hash=?,valid_from=?,valid_to=?,superseded_by=?,status=?,created_at=?,updated_at=?,deleted_at=? WHERE id=?').run(...values);
  }
  private where(f: RelationFilters): { sql: string; params: SQLInputValue[] } {
    const clauses = ['r.namespace=?', 'r.project IS ?']; const params: SQLInputValue[] = [f.namespace, f.project];
    if (!f.include_deleted) clauses.push('r.deleted_at IS NULL', 's.deleted_at IS NULL', 't.deleted_at IS NULL');
    clauses.push('s.namespace=r.namespace', 's.project IS r.project', 't.namespace=r.namespace', 't.project IS r.project');
    clauses.push('(r.source_memory_id IS NULL OR (m.id IS NOT NULL AND m.namespace=r.namespace AND m.project IS r.project))');
    if (!f.include_inactive) clauses.push("r.status<>'inactive'");
    if (!f.history) { const at = Date.parse(f.at ?? new Date().toISOString()); clauses.push('r.valid_from<=?', '(r.valid_to IS NULL OR r.valid_to>?)'); params.push(at, at); }
    if (!f.include_stale) {
      clauses.push('(r.source_memory_id IS NULL OR (m.id IS NOT NULL AND m.namespace=r.namespace AND m.project IS r.project AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) AND m.content_hash=r.source_content_hash))'); params.push(Date.now());
    }
    for (const key of ['source_entity_id', 'target_entity_id', 'predicate', 'source_memory_id'] as const) if (f[key]) { clauses.push(`r.${key}=?`); params.push(f[key]); }
    return { sql: clauses.join(' AND '), params };
  }
  private relationFrom = 'FROM relations r JOIN entities s ON s.id=r.source_entity_id JOIN entities t ON t.id=r.target_entity_id LEFT JOIN memories m ON m.id=r.source_memory_id';
  relations(f: RelationFilters): Relation[] {
    const { sql, params } = this.where(f);
    return this.db.prepare(`SELECT r.* ${this.relationFrom} WHERE ${sql} ORDER BY r.valid_from DESC,r.id LIMIT ? OFFSET ?`).all(...params,f.limit,f.offset).map(relation);
  }
  conflicts(r: Relation): Relation[] {
    return this.db.prepare(`SELECT * FROM relations WHERE namespace=? AND project IS ? AND source_entity_id=? AND predicate=? AND target_entity_id<>? AND id<>?
      AND deleted_at IS NULL AND status IN('active','conflict') AND superseded_by IS NULL AND (valid_to IS NULL OR valid_to>?) AND (? IS NULL OR valid_from<?) LIMIT 1001`)
      .all(r.namespace,r.project,r.source_entity_id,r.predicate,r.target_entity_id,r.id,millis(r.valid_from),millis(r.valid_to),millis(r.valid_to)).map(relation);
  }
  edges(ids: string[], scope: Scope, at: string, direction: 'in' | 'out' | 'both', limit: number,includeStale=false): Relation[] {
    if (!ids.length) return [];
    const { sql, params } = this.where({ ...scope, at, history: false, include_deleted: false, include_inactive: false, include_stale: includeStale, limit, offset: 0 });
    const slots = ids.map(() => '?').join(',');
    const edgeClause = direction === 'both' ? `(r.source_entity_id IN(${slots}) OR r.target_entity_id IN(${slots}))` : `r.${direction === 'out' ? 'source' : 'target'}_entity_id IN(${slots})`;
    return this.db.prepare(`SELECT r.* ${this.relationFrom} WHERE ${sql} AND ${edgeClause} ORDER BY r.id LIMIT ?`).all(...params,...ids,...(direction === 'both' ? ids : []),limit).map(relation);
  }
  link(memoryId: string, entityId: string, scope: Scope, role: string, confidence: number, unlink = false): void {
    transaction(this.db,()=>{
      const pair=this.db.prepare(`SELECT 1 FROM memories m JOIN entities e ON e.id=? WHERE m.id=? AND m.namespace=? AND m.project IS ?
        AND e.namespace=m.namespace AND e.project IS m.project
        ${unlink ? '' : 'AND m.deleted_at IS NULL AND e.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)'}`)
        .get(entityId,memoryId,scope.namespace,scope.project,...(unlink ? [] : [Date.now()]));
      if (!pair) throw new AppError('NOT_FOUND','Link endpoints are unavailable in the selected scope.');
      if (unlink) this.db.prepare('DELETE FROM memory_entities WHERE memory_id=? AND entity_id=? AND role=?').run(memoryId,entityId,role);
      else this.db.prepare('INSERT INTO memory_entities(memory_id,entity_id,role,confidence) VALUES(?,?,?,?) ON CONFLICT(memory_id,entity_id,role) DO UPDATE SET confidence=excluded.confidence').run(memoryId,entityId,role,confidence);
    });
  }
  links(entityIds: string[], filters: Filters, limit: number): string[] {
    if (!entityIds.length) return [];
    const { sql, params } = memoryWhere(filters);
    return this.db.prepare(`SELECT DISTINCT m.id FROM memories m JOIN memory_entities me ON me.memory_id=m.id JOIN entities e ON e.id=me.entity_id
      WHERE ${sql} AND e.namespace=m.namespace AND e.project IS m.project AND e.deleted_at IS NULL AND me.entity_id IN(${entityIds.map(() => '?').join(',')}) ORDER BY m.importance DESC,m.updated_at DESC,m.id LIMIT ?`)
      .all(...params,...entityIds,limit).map(r => String(r.id));
  }
  mergeLinks(targetId: string, sourceId: string, hash: string, scope: Scope): void {
    transaction(this.db,()=>{
      // Merge sources are soft-deleted before their links are transferred.
      const pair=this.db.prepare(`SELECT 1 FROM memories t JOIN memories s ON s.id=? WHERE t.id=? AND t.namespace=? AND t.project IS ?
        AND s.namespace=t.namespace AND s.project IS t.project AND t.content_hash=? AND t.deleted_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)`)
        .get(sourceId,targetId,scope.namespace,scope.project,hash,Date.now());
      if (!pair) throw new AppError('CONFLICT','Merge endpoints or target version are unavailable in the selected scope.');
      this.db.prepare(`INSERT OR IGNORE INTO memory_entities(memory_id,entity_id,role,confidence)
        SELECT ?,l.entity_id,l.role,l.confidence FROM memory_entities l JOIN entities e ON e.id=l.entity_id
        WHERE l.memory_id=? AND e.namespace=? AND e.project IS ?`).run(targetId,sourceId,scope.namespace,scope.project);
      this.db.prepare(`UPDATE relations SET source_memory_id=?,source_content_hash=? WHERE source_memory_id=? AND namespace=? AND project IS ?
        AND EXISTS(SELECT 1 FROM entities s JOIN entities t ON t.id=relations.target_entity_id WHERE s.id=relations.source_entity_id
          AND s.namespace=relations.namespace AND s.project IS relations.project AND t.namespace=relations.namespace AND t.project IS relations.project)`)
        .run(targetId,hash,sourceId,scope.namespace,scope.project);
    });
  }
  stats(scope: Scope): Record<string, number> {
    return { entities: Number(this.db.prepare('SELECT count(*) n FROM entities WHERE namespace=? AND project IS ? AND deleted_at IS NULL').get(scope.namespace,scope.project)!.n),
      relations: Number(this.db.prepare('SELECT count(*) n FROM relations WHERE namespace=? AND project IS ? AND deleted_at IS NULL').get(scope.namespace,scope.project)!.n) };
  }
  consistency(scope: Scope) {
    const invalid_relations = Number(this.db.prepare(`SELECT count(*) n FROM relations r LEFT JOIN entities s ON s.id=r.source_entity_id LEFT JOIN entities t ON t.id=r.target_entity_id LEFT JOIN memories m ON m.id=r.source_memory_id
      WHERE r.namespace=? AND r.project IS ? AND (s.id IS NULL OR t.id IS NULL OR s.namespace<>r.namespace OR t.namespace<>r.namespace OR s.project IS NOT r.project OR t.project IS NOT r.project
      OR (r.source_memory_id IS NOT NULL AND (m.id IS NULL OR m.namespace<>r.namespace OR m.project IS NOT r.project)))`).get(scope.namespace,scope.project)!.n);
    const invalid_links = Number(this.db.prepare(`SELECT count(*) n FROM memory_entities l LEFT JOIN memories m ON m.id=l.memory_id LEFT JOIN entities e ON e.id=l.entity_id
      WHERE ((m.namespace=? AND m.project IS ?) OR (m.id IS NULL AND e.namespace=? AND e.project IS ?)) AND (m.id IS NULL OR e.id IS NULL OR e.namespace<>m.namespace OR e.project IS NOT m.project)`)
      .get(scope.namespace,scope.project,scope.namespace,scope.project)!.n);
    return { invalid_relations, invalid_links };
  }
  orphanEntities(scope: Scope, limit: number): Entity[] {
    return this.db.prepare(`${entitySelect} WHERE e.namespace=? AND e.project IS ? AND e.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM relations r WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM memory_entities me WHERE me.entity_id=e.id) ORDER BY e.id LIMIT ?`).all(scope.namespace,scope.project,limit).map(entity);
  }
}
