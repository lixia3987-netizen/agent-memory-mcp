import type { SQLInputValue } from 'node:sqlite';
import type { Filters } from '../../domain/memory.ts';

export function memoryWhere(filters: Filters, now = Date.now()): { sql: string; params: SQLInputValue[] } {
  const clauses = ['m.namespace=?']; const params: SQLInputValue[] = [filters.namespace];
  if (!filters.all_projects) { clauses.push('m.project IS ?'); params.push(filters.project); }
  if (!filters.include_deleted) clauses.push('m.deleted_at IS NULL');
  if (!filters.include_expired) { clauses.push('(m.expires_at IS NULL OR m.expires_at>?)'); params.push(now); }
  for (const field of ['type', 'source'] as const) if (filters[field] !== undefined) { clauses.push(`m.${field}=?`); params.push(filters[field]); }
  for (const tag of new Set([...(filters.tags ?? []), ...(filters.tag ? [filters.tag] : [])])) {
    clauses.push('EXISTS(SELECT 1 FROM json_each(m.tags_json) AS t WHERE t.value=?)'); params.push(tag);
  }
  if (filters.importance_min !== undefined) { clauses.push('m.importance>=?'); params.push(filters.importance_min); }
  if (filters.created_after) { clauses.push('m.created_at>=?'); params.push(Date.parse(filters.created_after)); }
  if (filters.created_before) { clauses.push('m.created_at<=?'); params.push(Date.parse(filters.created_before)); }
  return { sql: clauses.join(' AND '), params };
}
