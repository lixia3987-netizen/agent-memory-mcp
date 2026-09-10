import path from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { importSchema, importRecordSchema } from '../domain/memory.ts';
import type { Scope } from '../domain/memory.ts';
import type { MemoryService } from './memory-service.ts';
import type { MemoryImporter, ImportFile, ParsedRecord } from '../importers/importer.ts';
import { JsonImporter } from '../importers/json.ts';
import { MarkdownImporter } from '../importers/markdown.ts';
import { ClaudeCodeImporter } from '../importers/claude-code.ts';
import { safeInputPath, safeRead } from '../shared/paths.ts';
import { sha256, contentHash } from '../shared/hash.ts';
import { AppError, asAppError } from '../shared/errors.ts';

export class ImportService {
  private memory: MemoryService;
  private backup: () => Promise<string>;
  private adapters: Map<string, MemoryImporter>;
  constructor(memory: MemoryService, backup: () => Promise<string>) {
    this.memory = memory; this.backup = backup;
    this.adapters = new Map([new JsonImporter(), new MarkdownImporter(), new ClaudeCodeImporter()].map(a => [a.id, a]));
  }
  register(adapter: MemoryImporter): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(adapter.id) || !adapter.extensions.length) throw new AppError('VALIDATION_ERROR','Importer requires a stable ID and file extensions.');
    if (this.adapters.has(adapter.id)) throw new AppError('CONFLICT','Importer ID is already registered.');
    this.adapters.set(adapter.id,adapter);
  }
  listAdapters() { return [...this.adapters.values()].map(adapter=>({ id:adapter.id,version:adapter.version,extensions:adapter.extensions })); }
  private files(inputPath: string, format: string): ImportFile[] {
    const options = this.memory.config.imports;
    const root = safeInputPath(inputPath, options.allowedRoots);
    const result: ImportFile[] = []; let visited = 0; let totalBytes = 0;
    const walk = (entry: string, depth: number, inMemory: boolean) => {
      if (depth > 16 || ++visited > options.maxFiles * 50) throw new AppError('VALIDATION_ERROR', 'Directory scan exceeds the traversal limit. Specify a narrower path.');
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) throw new AppError('PERMISSION_DENIED', 'Import tree contains a symbolic link or junction.');
      if (stat.isDirectory()) {
        for (const child of readdirSync(entry).sort()) walk(path.join(entry, child), depth + 1, inMemory || path.basename(entry) === 'memory');
      } else if (stat.isFile()) {
        const ext = path.extname(entry).toLowerCase();
        const accepted = this.adapters.get(format)!.extensions.includes(ext);
        if (!accepted || (format === 'claude-code' && !inMemory && entry !== root)) return;
        if (result.length >= options.maxFiles) throw new AppError('VALIDATION_ERROR', 'Import contains too many files.');
        const data = safeRead(entry, options.allowedRoots, options.maxFileBytes);
        totalBytes += Buffer.byteLength(data.text);
        if (totalBytes > 52428800) throw new AppError('VALIDATION_ERROR', 'Total import data exceeds 50 MiB. Split the import.');
        result.push({ ...data, path: entry, hash: sha256(data.text) });
      }
    };
    walk(root, 0, path.basename(root) === 'memory');
    if (!result.length) throw new AppError('IMPORT_FAILED', 'No matching files found. For Claude Code, specify a memory folder or its projects parent.');
    return result;
  }
  async run(input: unknown) {
    const v = importSchema.parse(input);
    if (v.format === 'claude-code' && v.data !== undefined) throw new AppError('VALIDATION_ERROR', 'Claude Code import requires an explicit path.');
    const adapter = this.adapters.get(v.format)!;
    if (!adapter) throw new AppError('UNSUPPORTED_FORMAT','Importer is not registered. Use the importers command to list adapters.');
    if (v.data !== undefined && Buffer.byteLength(v.data) > this.memory.config.imports.maxFileBytes) throw new AppError('VALIDATION_ERROR', 'Inline import exceeds the byte limit.');
    const files = v.data !== undefined ? [{ text: v.data, path: `inline:${v.format}`, hash: sha256(v.data), mtime: null }] : this.files(v.path!, v.format);
    // Parse and validate every record before any persistent writes.
    const parsed: ParsedRecord[] = [];
    for (const file of files) {
      if (adapter.detectVersion(file)===null) throw new AppError('UNSUPPORTED_FORMAT','Importer did not recognize the input schema version.');
      for (const item of adapter.parse(file)) {
        const scope = this.memory.scope({ namespace: v.namespace ?? item.record.namespace, project: v.project === undefined ? item.record.project : v.project });
        // Claude project directory names are opaque. Preserve each source project as
        // a distinct key unless the caller deliberately provides a project mapping.
        if (v.format === 'claude-code' && v.project === undefined) {
          const segments = path.dirname(file.path).split(path.sep); const i = segments.lastIndexOf('memory');
          if (i > 0) scope.project = segments[i - 1]!;
        }
        // Keep absent fields absent until we know whether this is a create or update.
        const record = importRecordSchema.parse(this.memory.policy.apply({ ...item.record, ...scope },false));
        if (record.created_at && record.updated_at && record.updated_at < record.created_at) throw new AppError('VALIDATION_ERROR', 'Imported updated_at precedes created_at.');
        parsed.push({ ...item, record });
        if (parsed.length > this.memory.config.imports.maxRecords) throw new AppError('VALIDATION_ERROR', 'Import contains too many records.');
      }
    }
    const stats = { dry_run: v.dry_run, files: files.length, records: parsed.length, added: 0, updated: 0, skipped: 0, copied: 0, backup_path: null as string | null };
    if (v.backup && !v.dry_run) stats.backup_path = await this.backup();
    const repo = this.memory.repository;
    const apply = (item: ParsedRecord) => {
      const scope = { namespace: item.record.namespace!, project: item.record.project ?? null } satisfies Scope;
      const origin = { ...scope, source_path: item.file.path, item_key: item.key, file_hash: item.file.hash };
      const exact = repo.importOrigin(origin, true);
      if (exact) { stats.skipped++; return; }
      const previous = repo.importOrigin(origin, false);
      let existing = previous && previous.namespace === scope.namespace && previous.project === scope.project ? previous : null;
      if (!existing && item.record.id) existing = repo.find(item.record.id, scope, true);
      if (!existing) existing = repo.duplicate(contentHash(scope.namespace, scope.project, item.record.content), scope);
      if (!existing && item.record.id && repo.hasGlobalIdCollision(item.record.id) && v.conflict !== 'copy') {
        throw new AppError('CONFLICT', 'Import ID is already used outside the target scope. Use copy to assign a new ID.');
      }
      if (existing && v.conflict === 'skip') { stats.skipped++; return; }
      if (existing && v.conflict === 'update') {
        const record = item.record;
        const next = this.memory.policy.apply({ ...existing, ...record, id: existing.id, namespace: existing.namespace, project: scope.project,
          type: record.type ?? existing.type, title: record.title === undefined ? existing.title : record.title,
          tags: record.tags ?? existing.tags, source: record.source ?? existing.source, importance: record.importance ?? existing.importance,
          expires_at: record.expires_at === undefined ? existing.expires_at : record.expires_at,
          deleted_at: record.deleted_at === undefined ? existing.deleted_at : record.deleted_at,
          metadata: record.metadata === undefined ? existing.metadata : record.metadata,
          created_at: record.created_at ?? existing.created_at, updated_at: record.updated_at ?? new Date().toISOString(),
          content_hash: contentHash(scope.namespace, scope.project, record.content) },false);
        next.content_hash=contentHash(scope.namespace,scope.project,next.content);
        if (Date.parse(next.updated_at)<Date.parse(next.created_at)) throw new AppError('VALIDATION_ERROR','Imported updated_at cannot precede created_at.');
        if (!next.deleted_at && repo.duplicate(next.content_hash, scope, next.id)) throw new AppError('CONFLICT', 'Imported update duplicates a different memory.');
        repo.replace(next); repo.audit(next, 'import_update'); repo.recordImport({ ...origin, memory_id: next.id }); stats.updated++;
      } else {
        const copy = v.conflict === 'copy' && (!!existing || (!!item.record.id && repo.hasGlobalIdCollision(item.record.id)));
        const record = copy ? { ...item.record, metadata: { ...item.record.metadata, copiedFromId: existing?.id ?? item.record.id } } : item.record;
        const result = this.memory.createRecord(record, v.format, copy);
        repo.recordImport({ ...origin, memory_id: result.memory.id });
        if (result.deduplicated) stats.skipped++; else if (copy) stats.copied++; else stats.added++;
      }
    };
    // A preview uses a rollback-only transaction so duplicate/conflict decisions
    // include earlier records from this same preview. Persistent imports commit 100 at a time.
    if (v.dry_run) repo.transaction(() => parsed.forEach(apply), true);
    else for (let i = 0; i < parsed.length; i += 100) {
      const before = { ...stats };
      try { repo.transaction(() => parsed.slice(i, i + 100).forEach(apply)); }
      catch (error) {
        Object.assign(stats, before);
        const e = asAppError(error);
        throw new AppError(e.code, `${e.message} Committed before failure: added=${stats.added}, updated=${stats.updated}, copied=${stats.copied}. Re-run safely using import provenance.`, e.retryable);
      }
      // Allow other MCP requests/stdio input between committed batches.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return stats;
  }
}
