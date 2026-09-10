import { randomUUID } from 'node:crypto';
import { addSchema, mutableSchema, listSchema, searchSchema, scopeSchema, idSchema, updateSchema, purgeSchema } from '../domain/memory.ts';
import type { Memory, Scope, Filters, ImportRecord } from '../domain/memory.ts';
import type { MemoryRepository } from '../repositories/memory-repository.ts';
import type { AsyncSearch } from '../repositories/async-search.ts';
import type { AppConfig } from '../app/config.ts';
import { contentHash } from '../shared/hash.ts';
import { AppError } from '../shared/errors.ts';
import { PolicyEngine } from '../domain/policy.ts';
import { nextUpdatedAt } from './memory-time.ts';

export class MemoryService {
  readonly repository: MemoryRepository;
  readonly config: AppConfig;
  readonly policy: PolicyEngine;
  private asyncSearch?: AsyncSearch;
  constructor(repository: MemoryRepository, config: AppConfig, asyncSearch?: AsyncSearch) {
    this.repository = repository; this.config = config; this.policy=new PolicyEngine(config.policy); this.asyncSearch = asyncSearch;
  }
  scope(input: unknown): Scope {
    const v = scopeSchema.parse(input);
    return { namespace: v.namespace ?? this.config.namespace, project: v.project === undefined ? this.config.project : v.project };
  }
  filters(input: unknown): Filters {
    const v = listSchema.parse(input);
    if (v.all_projects && v.project !== undefined) throw new AppError('VALIDATION_ERROR', 'all_projects cannot be combined with project.');
    if (v.created_after && v.created_before && v.created_after > v.created_before) throw new AppError('VALIDATION_ERROR', 'created_after must not exceed created_before.');
    if ((v.limit ?? this.config.search.defaultLimit) > this.config.search.maxLimit) throw new AppError('VALIDATION_ERROR', `limit exceeds configured maximum ${this.config.search.maxLimit}.`);
    return { ...v, ...this.scope({ namespace: v.namespace, project: v.project }), limit: v.limit ?? this.config.search.defaultLimit };
  }
  add(input: unknown, defaultSource = 'manual'): { memory: Memory; deduplicated: boolean } {
    const v = addSchema.parse(input);
    return this.repository.transaction(() => this.createRecord(v, defaultSource));
  }
  // Import service validates its DTO before calling this inside a short transaction.
  createRecord(v: ImportRecord, defaultSource: string, forceCopy = false): { memory: Memory; deduplicated: boolean } {
    v=this.policy.apply({ ...v,source:v.source ?? defaultSource,namespace:v.namespace ?? this.config.namespace });
    const scope = this.scope({ namespace: v.namespace, project: v.project });
    const hash = contentHash(scope.namespace, scope.project, v.content);
    const duplicate = this.repository.duplicate(hash, scope);
    if (duplicate && !forceCopy) return { memory: duplicate, deduplicated: true };
    const now = new Date().toISOString();
    const memory: Memory = { ...scope, id: forceCopy ? randomUUID() : v.id ?? randomUUID(), type: v.type ?? 'note', title: v.title ?? null,
      content: v.content, tags: v.tags ?? [], source: v.source ?? defaultSource, importance: v.importance ?? 5,
      expires_at: v.expires_at ?? null, metadata: v.metadata ?? null, content_hash: hash,
      created_at: v.created_at ?? now, updated_at: v.updated_at ?? v.created_at ?? now, deleted_at: v.deleted_at ?? null };
    if (Date.parse(memory.updated_at) < Date.parse(memory.created_at)) throw new AppError('VALIDATION_ERROR', 'updated_at cannot precede created_at.');
    this.repository.insert(memory); this.repository.audit(memory, 'add');
    return { memory, deduplicated: false };
  }
  get(input: unknown): Memory & { expired: boolean } {
    const v = idSchema.parse(input);
    const memory = this.repository.find(v.id, this.scope({ namespace: v.namespace, project: v.project }), v.include_deleted);
    if (!memory) throw new AppError('NOT_FOUND', 'Memory not found in this namespace/project. Check scope and include_deleted.');
    return { ...memory, expired: memory.expires_at !== null && Date.parse(memory.expires_at) <= Date.now() };
  }
  update(input: unknown): Memory {
    const v = updateSchema.parse(input);
    return this.repository.transaction(() => {
      const old = this.get({ id: v.id, namespace: v.namespace, project: v.project });
      const { expired: _expired, ...base } = old;
      const next: Memory = this.policy.apply({ ...base, ...mutableSchema.parse(v.updates), updated_at: nextUpdatedAt(base) },false);
      next.content_hash = contentHash(next.namespace, next.project, next.content);
      if (this.repository.duplicate(next.content_hash, next, next.id)) throw new AppError('CONFLICT', 'Update would duplicate an existing active memory.');
      this.repository.replace(next); this.repository.audit(next, 'update'); return next;
    });
  }
  delete(input: unknown): { id: string; deleted_at: string } {
    const v = idSchema.parse(input);
    return this.repository.transaction(() => {
      const { expired: _expired, ...memory } = this.get({ ...v, include_deleted: true });
      if (!memory.deleted_at) {
        memory.deleted_at = new Date().toISOString(); memory.updated_at = nextUpdatedAt(memory);
        this.repository.replace(memory); this.repository.audit(memory, 'delete');
      }
      return { id: memory.id, deleted_at: memory.deleted_at };
    });
  }
  restore(input: unknown): Memory {
    const v = idSchema.parse(input);
    return this.repository.transaction(() => {
      const { expired: _expired, ...memory } = this.get({ ...v, include_deleted: true });
      if (memory.deleted_at) {
        if (this.repository.duplicate(memory.content_hash, memory, memory.id)) throw new AppError('CONFLICT', 'An active duplicate exists; resolve it before restoring.');
        memory.deleted_at = null; memory.updated_at = nextUpdatedAt(memory);
        this.repository.replace(memory); this.repository.audit(memory, 'restore');
      }
      return memory;
    });
  }
  list(input: unknown) { return this.repository.list(this.filters(input)); }
  purge(input: unknown): { purged: number } {
    const { before, confirmed: _confirmed, ...filters } = purgeSchema.parse(input);
    return { purged: this.repository.purge(this.filters(filters), before) };
  }
  search(input: unknown) {
    const { query, ...filters } = searchSchema.parse(input);
    return { memories: this.repository.search(query, this.filters(filters)), query, mode: 'lexical' as const };
  }
  async searchAsync(input: unknown) {
    const { query, ...filters } = searchSchema.parse(input);
    const parsed = this.filters(filters);
    const memories = this.asyncSearch ? await this.asyncSearch.search(query, parsed, Date.now()) : this.repository.search(query, parsed);
    return { memories, query, mode: 'lexical' as const };
  }
}
