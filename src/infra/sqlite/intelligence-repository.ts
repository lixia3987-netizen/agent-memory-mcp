import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Scope, Filters, Memory } from '../../domain/memory.ts';
import type { StoredEmbedding, Enrichment, Job } from '../../domain/intelligence.ts';
import { enrichmentResultSchema } from '../../domain/intelligence.ts';
import type { IntelligenceRepository, IntelligenceStats } from '../../repositories/intelligence-repository.ts';
import { decodeMemory } from './memory-repository.ts';
import { memoryWhere } from './memory-filters.ts';
import { AppError } from '../../shared/errors.ts';

function decodeJob(row: Record<string,unknown>): Job {
  return { id:String(row.id),memory_id:String(row.memory_id),content_hash:String(row.content_hash),status:String(row.status),attempts:Number(row.attempts),
    lease_until:row.lease_until===null ? null : Number(row.lease_until),lease_token:row.lease_token===null ? null : String(row.lease_token),last_error:row.last_error===null ? null : String(row.last_error) };
}
export class SqliteIntelligenceRepository implements IntelligenceRepository {
  private db: DatabaseSync; constructor(db: DatabaseSync) { this.db=db; }
  candidates(f: Filters,limit: number,maxBytes: number) {
    const { sql,params }=memoryWhere(f);const memories: Memory[]=[];let bytes=0;let truncated=false;
    for (const row of this.db.prepare(`SELECT m.* FROM memories m WHERE ${sql} ORDER BY m.updated_at DESC,m.id LIMIT ?`).iterate(...params,limit+1)) {
      const m=decodeMemory(row);bytes+=Buffer.byteLength(JSON.stringify(m));
      if (memories.length>=limit || bytes>maxBytes) { truncated=true;break; }memories.push(m);
    }
    return { memories,truncated };
  }
  findFiltered(ids: string[],f: Filters): Memory[] {
    if (!ids.length) return [];
    const { sql,params }=memoryWhere(f);
    return this.db.prepare(`SELECT m.* FROM memories m WHERE ${sql} AND m.id IN(${ids.map(()=>'?').join(',')})`).all(...params,...ids).map(decodeMemory);
  }
  pendingEmbeddings(scope: Scope,provider: string,model: string,limit: number,force: boolean,afterId?:string): Memory[] {
    return this.db.prepare(`SELECT m.* FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id AND e.provider=? AND e.model=?
      WHERE m.namespace=? AND m.project IS ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?)
      ${force ? '' : 'AND (e.memory_id IS NULL OR e.content_hash<>m.content_hash)'} ${afterId ? 'AND m.id>?' : ''} ORDER BY m.id LIMIT ?`)
      .all(provider,model,scope.namespace,scope.project,Date.now(),...(afterId ? [afterId] : []),limit).map(decodeMemory);
  }
  saveEmbedding(e: StoredEmbedding,scope: Scope): boolean {
    const bytes=Buffer.alloc(e.vector.length*4);e.vector.forEach((value,i)=>bytes.writeFloatLE(value,i*4));
    const result=this.db.prepare(`INSERT INTO memory_embeddings(memory_id,provider,model,dimensions,vector,content_hash,created_at)
      SELECT id,?,?,?,?,?,? FROM memories WHERE id=? AND namespace=? AND project IS ? AND content_hash=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?)
      ON CONFLICT(memory_id,provider,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector,content_hash=excluded.content_hash,created_at=excluded.created_at`)
      .run(e.provider,e.model,e.dimensions,bytes,e.content_hash,Date.parse(e.created_at),e.memory_id,scope.namespace,scope.project,e.content_hash,Date.now());
    return Number(result.changes)>0;
  }
  vectors(f: Filters,provider: string,model: string,limit: number,maxBytes: number) {
    const { sql,params }=memoryWhere(f);const embeddings: StoredEmbedding[]=[];let bytes=0;let truncated=false;
    for (const row of this.db.prepare(`SELECT e.* FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE ${sql} AND e.provider=? AND e.model=? AND e.content_hash=m.content_hash ORDER BY m.updated_at DESC,m.id LIMIT ?`).iterate(...params,provider,model,limit+1)) {
      const blob=Buffer.from(row.vector as Uint8Array);bytes+=blob.byteLength;const dimensions=Number(row.dimensions);
      if (embeddings.length>=limit || bytes>maxBytes) { truncated=true;break; }
      if (dimensions<1 || dimensions>8192 || blob.length!==dimensions*4) throw new AppError('DATABASE_CORRUPT','Stored vector dimensions are invalid. Rebuild embeddings.');
      const vector=Array.from({ length:dimensions },(_,i)=>blob.readFloatLE(i*4));
      if (!vector.every(Number.isFinite)) throw new AppError('DATABASE_CORRUPT','Stored vectors contain invalid numbers. Rebuild embeddings.');
      embeddings.push({ memory_id:String(row.memory_id),provider:String(row.provider),model:String(row.model),dimensions,vector,content_hash:String(row.content_hash),created_at:new Date(Number(row.created_at)).toISOString() });
    }
    return { embeddings,truncated };
  }
  enrichment(id: string,scope: Scope): Enrichment | null {
    const row=this.db.prepare('SELECT e.* FROM memory_enrichments e JOIN memories m ON m.id=e.memory_id WHERE m.id=? AND m.namespace=? AND m.project IS ? AND m.content_hash=e.content_hash AND m.deleted_at IS NULL').get(id,scope.namespace,scope.project);
    return row ? { memory_id:id,provider:String(row.provider),model:String(row.model),content_hash:String(row.content_hash),result:enrichmentResultSchema.parse(JSON.parse(String(row.result_json))),created_at:new Date(Number(row.created_at)).toISOString(),applied_at:row.applied_at===null ? null : new Date(Number(row.applied_at)).toISOString() } : null;
  }
  saveEnrichment(e: Enrichment,scope: Scope): boolean {
    return Number(this.db.prepare(`INSERT INTO memory_enrichments(memory_id,provider,model,content_hash,result_json,created_at,applied_at)
      SELECT id,?,?,?,?,?,NULL FROM memories WHERE id=? AND namespace=? AND project IS ? AND content_hash=? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?)
      ON CONFLICT(memory_id) DO UPDATE SET provider=excluded.provider,model=excluded.model,content_hash=excluded.content_hash,result_json=excluded.result_json,created_at=excluded.created_at,applied_at=NULL`)
      .run(e.provider,e.model,e.content_hash,JSON.stringify(e.result),Date.parse(e.created_at),e.memory_id,scope.namespace,scope.project,e.content_hash,Date.now()).changes)>0;
  }
  markApplied(id: string,hash: string,scope: Scope): boolean {
    const now=Date.now();
    return Number(this.db.prepare(`UPDATE memory_enrichments SET applied_at=? WHERE memory_id=? AND content_hash=? AND applied_at IS NULL
      AND EXISTS(SELECT 1 FROM memories m WHERE m.id=memory_enrichments.memory_id AND m.namespace=? AND m.project IS ?
        AND m.content_hash=memory_enrichments.content_hash AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?))`)
      .run(now,id,hash,scope.namespace,scope.project,now).changes)>0;
  }
  enqueue(m: Memory,restart=false): Job {
    const now=Date.now();
    const reset="(enrichment_jobs.status IN('failed','stale') OR (? AND enrichment_jobs.status='completed'))";
    this.db.prepare(`INSERT INTO enrichment_jobs(id,memory_id,content_hash,status,created_at,updated_at) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(memory_id,content_hash) DO UPDATE SET
      status=CASE WHEN ${reset} THEN 'pending' ELSE enrichment_jobs.status END,
      attempts=CASE WHEN ${reset} THEN 0 ELSE enrichment_jobs.attempts END,
      lease_until=CASE WHEN ${reset} THEN NULL ELSE enrichment_jobs.lease_until END,
      lease_token=CASE WHEN ${reset} THEN NULL ELSE enrichment_jobs.lease_token END,
      last_error=CASE WHEN ${reset} THEN NULL ELSE enrichment_jobs.last_error END,updated_at=excluded.updated_at`)
      .run(randomUUID(),m.id,m.content_hash,now,now,...Array<number>(5).fill(Number(restart)));
    return decodeJob(this.db.prepare('SELECT * FROM enrichment_jobs WHERE memory_id=? AND content_hash=?').get(m.id,m.content_hash)!);
  }
  claimJob(scope: Scope,leaseMs: number,id?: string,maxAttempts=3): Job | null {
    if (!Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>100) throw new AppError('VALIDATION_ERROR','maxAttempts must be an integer between 1 and 100.');
    const now=Date.now(); const token=randomUUID();
    // Retire legacy pending jobs and abandoned final leases; never touch a live lease.
    this.db.prepare(`UPDATE enrichment_jobs SET status='failed',last_error=coalesce(last_error,'MAX_ATTEMPTS'),lease_until=NULL,lease_token=NULL,updated_at=?
      WHERE attempts>=? AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<=?)))
      AND memory_id IN(SELECT id FROM memories WHERE namespace=? AND project IS ?) ${id ? 'AND id=?' : ''}`)
      .run(now,maxAttempts,now,scope.namespace,scope.project,...(id ? [id] : []));
    const row=this.db.prepare(`UPDATE enrichment_jobs SET status='running',attempts=attempts+1,lease_until=?,lease_token=?,updated_at=? WHERE id=(
      SELECT j.id FROM enrichment_jobs j JOIN memories m ON m.id=j.memory_id WHERE m.namespace=? AND m.project IS ? AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>?) AND m.content_hash=j.content_hash
      AND j.attempts<? AND (j.status='pending' OR (j.status='running' AND (j.lease_until IS NULL OR j.lease_until<=?))) ${id ? 'AND j.id=?' : ''} ORDER BY j.updated_at,j.id LIMIT 1) RETURNING *`)
      .get(now+leaseMs,token,now,scope.namespace,scope.project,now,maxAttempts,now,...(id ? [id] : []));
    return row ? decodeJob(row) : null;
  }
  finishJob(id: string,token: string,status: string,error?: string): void {
    this.db.prepare("UPDATE enrichment_jobs SET status=?,last_error=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'").run(status,error ?? null,Date.now(),id,token);
  }
  ownsJob(id: string,token: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM enrichment_jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?").get(id,token,Date.now());
  }
  saveMerge(target: Memory,source: Memory): void {
    this.db.prepare('INSERT INTO memory_merges(id,target_id,source_id,target_before_json,source_before_json,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),target.id,source.id,JSON.stringify(target),JSON.stringify(source),Date.now());
  }
  recordGlobalToolMetrics(tool: string,elapsed: number,error: boolean): void {
    this.db.prepare('INSERT INTO tool_metrics(tool,calls,errors,total_ms,max_ms,updated_at) VALUES(?,1,?,?,?,?) ON CONFLICT(tool) DO UPDATE SET calls=calls+1,errors=errors+excluded.errors,total_ms=total_ms+excluded.total_ms,max_ms=max(max_ms,excluded.max_ms),updated_at=excluded.updated_at').run(tool,Number(error),elapsed,elapsed,Date.now());
  }
  recordGlobalImportMetrics(importer: string,stats: unknown): void {
    this.db.prepare('INSERT INTO import_metrics(importer,stats_json,created_at) VALUES(?,?,?)').run(importer,JSON.stringify(stats),Date.now());
    this.db.exec('DELETE FROM import_metrics WHERE id < (SELECT coalesce(max(id),0)-100 FROM import_metrics)');
  }
  stats(scope: Scope): IntelligenceStats {
    const counts=this.db.prepare(`SELECT
      (SELECT count(*) FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE m.namespace=? AND m.project IS ? AND m.content_hash=e.content_hash) embeddings,
      (SELECT count(*) FROM memory_enrichments e JOIN memories m ON m.id=e.memory_id WHERE m.namespace=? AND m.project IS ? AND m.content_hash=e.content_hash) enrichments,
      (SELECT count(*) FROM enrichment_jobs j JOIN memories m ON m.id=j.memory_id WHERE m.namespace=? AND m.project IS ? AND j.status IN('pending','running')) pending_jobs`).get(scope.namespace,scope.project,scope.namespace,scope.project,scope.namespace,scope.project)!;
    return { embeddings:Number(counts.embeddings),enrichments:Number(counts.enrichments),pending_jobs:Number(counts.pending_jobs),metrics_scope:'whole_database',
      tool_metrics:this.db.prepare('SELECT tool,calls,errors,total_ms/calls average_ms,max_ms FROM tool_metrics ORDER BY tool').all()
        .map(r=>({tool:String(r.tool),calls:Number(r.calls),errors:Number(r.errors),average_ms:Number(r.average_ms),max_ms:Number(r.max_ms)})),
      recent_imports:this.db.prepare('SELECT importer,stats_json,created_at FROM import_metrics ORDER BY id DESC LIMIT 10').all().map(r=>({ importer:String(r.importer),stats:JSON.parse(String(r.stats_json)) as unknown,created_at:new Date(Number(r.created_at)).toISOString() })) };
  }
  expired(scope: Scope,limit: number): Memory[] {
    return this.db.prepare('SELECT * FROM memories WHERE namespace=? AND project IS ? AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,id LIMIT ?').all(scope.namespace,scope.project,Date.now(),limit).map(decodeMemory);
  }
  rebuildFts(): void { this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');INSERT INTO memories_cjk(memories_cjk) VALUES('rebuild');"); }
  vacuum(): void { this.db.exec('PRAGMA wal_checkpoint(PASSIVE);VACUUM;'); }
}
