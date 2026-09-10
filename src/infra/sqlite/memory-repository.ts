import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AppConfig } from '../../app/config.ts';
import type { Filters, Memory, Scope, SearchHit } from '../../domain/memory.ts';
import type { MemoryRepository, ImportOrigin } from '../../repositories/memory-repository.ts';
import { literalFtsQuery } from '../../services/ranking.ts';
import { AppError } from '../../shared/errors.ts';
import { memoryWhere } from './memory-filters.ts';
import { transaction } from './transaction.ts';
import type { SyncOperation } from '../../repositories/transaction.ts';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => new Date(Number(value)).toISOString();
const time = (value: string | null): number | null => value === null ? null : Date.parse(value);
function decode(row: Row): Memory {
  return { id: String(row.id), namespace: String(row.namespace), project: row.project === null ? null : String(row.project),
    type: String(row.type), title: row.title === null ? null : String(row.title), content: String(row.content),
    tags: JSON.parse(String(row.tags_json)) as string[], source: String(row.source), importance: Number(row.importance),
    content_hash: String(row.content_hash), metadata: row.metadata_json === null ? null : JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), expires_at: row.expires_at === null ? null : iso(row.expires_at),
    deleted_at: row.deleted_at === null ? null : iso(row.deleted_at) };
}
export { decode as decodeMemory };
function values(m: Memory): SQLInputValue[] {
  return [m.id, m.namespace, m.project, m.type, m.title, m.content, JSON.stringify(m.tags), m.tags.join(' '), m.source, m.importance,
    m.content_hash, m.metadata === null ? null : JSON.stringify(m.metadata), time(m.created_at), time(m.updated_at), time(m.expires_at), time(m.deleted_at)];
}
export class SqliteMemoryRepository implements MemoryRepository {
  private db: DatabaseSync;
  private config: AppConfig;
  constructor(db: DatabaseSync, config: AppConfig) { this.db = db; this.config = config; }
  transaction<T>(operation: SyncOperation<T>, dryRun = false): T {
    return transaction(this.db, operation, dryRun);
  }
  find(id: string, scope: Scope, includeDeleted = false): Memory | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id=? AND namespace=? AND project IS ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id, scope.namespace, scope.project);
    return row ? decode(row) : null;
  }
  hasGlobalIdCollision(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(id); }
  duplicate(hash: string, scope: Scope, excludingId = ''): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE content_hash=? AND namespace=? AND project IS ? AND id<>? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at,id LIMIT 1')
      .get(hash, scope.namespace, scope.project, excludingId, Date.now());
    return row ? decode(row) : null;
  }
  insert(m: Memory): void { this.db.prepare('INSERT INTO memories(id,namespace,project,type,title,content,tags_json,tags_text,source,importance,content_hash,metadata_json,created_at,updated_at,expires_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...values(m)); }
  replace(m: Memory): void {
    const v = values(m);
    this.db.prepare('UPDATE memories SET namespace=?,project=?,type=?,title=?,content=?,tags_json=?,tags_text=?,source=?,importance=?,content_hash=?,metadata_json=?,created_at=?,updated_at=?,expires_at=?,deleted_at=? WHERE id=?').run(...v.slice(1), m.id);
  }
  audit(m: Pick<Memory, 'id' | 'namespace' | 'project'>, action: string): void {
    this.db.prepare('INSERT INTO audit_events(memory_id,action,occurred_at,namespace,project) VALUES(?,?,?,?,?)').run(m.id, action, Date.now(), m.namespace, m.project);
  }
  list(filters: Filters): { memories: Memory[]; total: number } {
    const { sql, params } = memoryWhere(filters);
    const order = { updated_desc: 'm.updated_at DESC', created_desc: 'm.created_at DESC', created_asc: 'm.created_at ASC', importance_desc: 'm.importance DESC, m.updated_at DESC' }[filters.sort ?? 'updated_desc'];
    const rows = this.db.prepare(`SELECT m.* FROM memories m WHERE ${sql} ORDER BY ${order},m.id LIMIT ? OFFSET ?`).all(...params, filters.limit ?? 10, filters.offset ?? 0);
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${sql}`).get(...params)!.n);
    return { memories: rows.map(decode), total };
  }
  exportRecords(filters: Filters, maxBytes: number): Memory[] {
    const { sql, params } = memoryWhere(filters);
    const records: Memory[] = []; let bytes = 0;
    for (const row of this.db.prepare(`SELECT m.* FROM memories m WHERE ${sql} ORDER BY m.created_at,m.id`).iterate(...params)) {
      const memory = decode(row);
      bytes += Buffer.byteLength(JSON.stringify(memory));
      if (bytes > maxBytes || records.length >= 100000) throw new AppError('VALIDATION_ERROR', 'Export exceeds the record or byte limit. Narrow the filters.');
      records.push(memory);
    }
    return records;
  }
  search(query: string, filters: Filters): SearchHit[] {
    const now = Date.now(); const { sql, params } = memoryWhere(filters, now);
    const words = query.trim().split(/\s+/u);
    const cjk = /\p{Script=Han}/u.test(query);
    // FTS5 trigram MATCH cannot match tokens shorter than three code points.
    // Keep long words as indexed anchors and require every short word literally.
    const indexedWords = cjk ? words.filter(w => [...w].length >= 3) : words;
    const shortWords = cjk ? words.filter(w => [...w].length < 3) : [];
    const table = cjk ? 'memories_cjk' : 'memories_fts';
    const columns = ['title','content','tags_text','project','type'];
    const shortClauses = shortWords.map(() => '(' + columns.map(column => `instr(lower(coalesce(m.${column},'')),lower(?))>0`).join(' OR ') + ')');
    const shortParams = shortWords.flatMap(word => columns.map(() => word));
    const indexed = indexedWords.length > 0;
    const { importanceBoost: ib, recencyBoost: rb } = this.config.search;
    // A rational age decay avoids relying on optional SQLite math extensions.
    const score = `${indexed ? `(-bm25(${table},3.0,1.0,2.0,1.0,1.0))` : '1.0'}*(1+${ib}*m.importance/10.0+${rb}/(1+max(0,${now}-m.updated_at)/7776000000.0))`;
    // All-short CJK queries scan the filtered scope, with the same ordering/pagination.
    const from = indexed ? `${table} JOIN memories m ON m.rowid=${table}.rowid` : 'memories m';
    const snippet = indexed ? `snippet(${table},-1,'[',']','…',32)` : 'substr(m.content,1,600)';
    const clauses = [...(indexed ? [`${table} MATCH ?`] : []), sql, ...shortClauses];
    const rows = this.db.prepare(`SELECT m.*, ${snippet} AS snippet, ${score} AS score FROM ${from}
      WHERE ${clauses.join(' AND ')} ORDER BY score DESC,m.updated_at DESC,m.id LIMIT ? OFFSET ?`)
      .all(...(indexed ? [literalFtsQuery(indexedWords.join(' '))] : []), ...params, ...shortParams, filters.limit ?? 10, filters.offset ?? 0);
    return rows.map(row => {
      const { content: _content, metadata: _metadata, content_hash: _hash, deleted_at: _deleted, ...memory } = decode(row);
      const rawScore = Math.max(0, Number(row.score));
      return { ...memory, snippet: String(row.snippet).slice(0, 600), score: rawScore / (1 + rawScore) };
    });
  }
  importOrigin(origin: Omit<ImportOrigin, 'memory_id'>, exactHash: boolean): Memory | null {
    const row = this.db.prepare(`SELECT m.* FROM import_items i JOIN memories m ON m.id=i.memory_id
      WHERE i.namespace=? AND i.project_key=? AND m.namespace=i.namespace AND m.project IS ? AND i.source_path=? AND i.item_key=? ${exactHash ? 'AND i.file_hash=?' : ''}
      ORDER BY i.imported_at DESC,i.rowid DESC LIMIT 1`).get(origin.namespace, JSON.stringify(origin.project), origin.project, origin.source_path, origin.item_key, ...(exactHash ? [origin.file_hash] : []));
    return row ? decode(row) : null;
  }
  recordImport(origin: ImportOrigin): void {
    this.db.prepare('INSERT OR REPLACE INTO import_items(namespace,project_key,source_path,item_key,file_hash,memory_id,imported_at) VALUES(?,?,?,?,?,?,?)')
      .run(origin.namespace, JSON.stringify(origin.project), origin.source_path, origin.item_key, origin.file_hash, origin.memory_id, Date.now());
  }
  purge(filters: Filters, before: string): number {
    const { sql, params } = memoryWhere({ ...filters, include_deleted: true, include_expired: true });
    return this.transaction(() => {
      const targets = this.db.prepare(`SELECT m.id,m.namespace,m.project FROM memories m WHERE ${sql} AND m.deleted_at IS NOT NULL AND m.deleted_at<=?`).iterate(...params, Date.parse(before));
      for (const row of targets) this.audit({ id: String(row.id), namespace: String(row.namespace), project: row.project === null ? null : String(row.project) }, 'purge');
      return Number(this.db.prepare(`DELETE FROM memories WHERE id IN(SELECT m.id FROM memories m WHERE ${sql} AND m.deleted_at IS NOT NULL AND m.deleted_at<=?)`).run(...params, Date.parse(before)).changes);
    });
  }
  stats(scope: Scope): Record<string, number> {
    const row = this.db.prepare(`SELECT count(*) total,
      coalesce(sum(deleted_at IS NOT NULL),0) deleted,
      coalesce(sum(deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?),0) expired,
      coalesce(sum(deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?)),0) active
      FROM memories WHERE namespace=? AND project IS ?`).get(Date.now(), Date.now(), scope.namespace, scope.project)!;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }
}
