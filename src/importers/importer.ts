import type { ImportRecord } from '../domain/memory.ts';

export type ImportFile = { text: string; path: string; hash: string; mtime: number | null };
export type ParsedRecord = { record: ImportRecord; key: string; file: ImportFile };
export interface MemoryImporter {
  readonly id: string;
  readonly version: number;
  readonly extensions: readonly string[];
  detectVersion(file: ImportFile): string | null;
  parse(file: ImportFile): ParsedRecord[];
}
