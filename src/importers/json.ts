import { z } from 'zod';
import { importRecordSchema } from '../domain/memory.ts';
import type { MemoryImporter, ImportFile } from './importer.ts';
import { AppError } from '../shared/errors.ts';

export const exportDocumentSchema = z.object({ schemaVersion: z.literal(1), exportedAt: z.string(), memories: z.array(importRecordSchema) }).strict();
export class JsonImporter implements MemoryImporter {
  readonly id = 'json'; readonly version = 1;
  readonly extensions = ['.json'];
  detectVersion(file: ImportFile): string | null {
    try { const value=JSON.parse(file.text) as {schemaVersion?:unknown};return value?.schemaVersion===1 ? '1' : null; } catch { return null; }
  }
  parse(file: ImportFile) {
    let data: unknown;
    try { data = JSON.parse(file.text); } catch { throw new AppError('IMPORT_FAILED', 'JSON input is malformed.'); }
    const records = exportDocumentSchema.parse(data).memories;
    return records.map((record, i) => ({ record, key: record.id ?? `record:${i}`, file }));
  }
}
