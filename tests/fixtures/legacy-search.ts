// Frozen v0.2.5 search query: independent correctness/performance oracle.
// Keep the old SQL shape; do not refactor it to share the production query builder.
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../../src/app/config.ts';
import type { Filters, SearchHit } from '../../src/domain/memory.ts';
import { decodeMemory as decode } from '../../src/infra/sqlite/memory-repository.ts';
import { memoryWhere } from '../../src/infra/sqlite/memory-filters.ts';
import { literalFtsQuery } from '../../src/services/ranking.ts';

export class LegacySearch {
  private db: DatabaseSync;
  private config: AppConfig;
  constructor(db: DatabaseSync, config: AppConfig) { this.db = db; this.config = config; }
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
}
