import { stringify } from 'yaml';
import { exportSchema } from '../domain/memory.ts';
import type { MemoryService } from './memory-service.ts';
import { AppError } from '../shared/errors.ts';

export class ExportService {
  private memory: MemoryService;
  constructor(memory: MemoryService) { this.memory = memory; }
  run(input: unknown) {
    const { format, ...rest } = exportSchema.parse(input);
    const filters = this.memory.filters(rest);
    // A single SELECT reads a coherent SQLite snapshot without blocking WAL writers.
    const memories = this.memory.repository.exportRecords(filters, this.memory.config.maxExportBytes);
    const document = { schemaVersion: 1, exportedAt: new Date().toISOString(), memories };
    let data: string;
    if (format === 'json') data = JSON.stringify(document, null, 2) + '\n';
    else {
      // Canonical records live in a versioned YAML header for lossless round trips;
      // the Markdown body is a readable view, not reparsed as extra records.
      data = `---\n${stringify(document, { lineWidth: 0 })}---\n\n# Agent Memory Export\n\n` + memories.map(m => `## ${m.title ?? m.id}\n\n${m.content}\n`).join('\n');
    }
    if (Buffer.byteLength(data) > this.memory.config.maxExportBytes) throw new AppError('VALIDATION_ERROR', 'Export exceeds the configured byte limit. Narrow the filters.');
    return { schemaVersion: 1, format, count: memories.length, data };
  }
}
