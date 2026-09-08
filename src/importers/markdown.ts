import path from 'node:path';
import { parseDocument } from 'yaml';
import { importRecordSchema } from '../domain/memory.ts';
import { exportDocumentSchema } from './json.ts';
import type { MemoryImporter, ImportFile, ParsedRecord } from './importer.ts';
import { AppError } from '../shared/errors.ts';

export function frontmatter(text: string): { attributes: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized };
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new AppError('IMPORT_FAILED', 'Markdown frontmatter has no closing delimiter.');
  const doc = parseDocument(match[1]!, { uniqueKeys: true, customTags: [] });
  if (doc.errors.length) throw new AppError('IMPORT_FAILED', 'Markdown frontmatter contains invalid YAML.');
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 20 }); }
  catch { throw new AppError('IMPORT_FAILED', 'Markdown frontmatter exceeds the YAML alias limit.'); }
  if (value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('IMPORT_FAILED', 'Markdown frontmatter must be an object.');
  return { attributes: value as Record<string, unknown>, body: normalized.slice(match[0].length) };
}
export function splitHeadings(body: string): { title: string | null; content: string; key: string }[] {
  const sections: { title: string | null; content: string; key: string }[] = [];
  let lines: string[] = []; let heading: string | null = null; let fence: string | null = null;
  const occurrences = new Map<string, number>();
  const flush = () => {
    const content = lines.join('\n').trim();
    if (content) {
      const name = heading ?? 'preamble'; const nth = occurrences.get(name) ?? 0;
      occurrences.set(name, nth + 1); sections.push({ title: heading, content, key: `${name}:${nth}` });
    }
    lines = [];
  };
  for (const line of body.split('\n')) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (opening && opening[0] === fence[0] && opening.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = null;
    } else if (opening) fence = opening;
    else {
      const match = /^#{2,3}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
      if (match) { flush(); heading = match[1]!; }
    }
    lines.push(line);
  }
  flush(); return sections;
}
export class MarkdownImporter implements MemoryImporter {
  readonly id: string = 'markdown'; readonly version = 1;
  readonly extensions = ['.md'];
  detectVersion(file: ImportFile): string | null {
    const { attributes }=frontmatter(file.text);
    return 'schemaVersion' in attributes ? attributes.schemaVersion===1 ? 'export-v1' : null : 'markdown-frontmatter-v1';
  }
  parse(file: ImportFile): ParsedRecord[] {
    const { attributes, body } = frontmatter(file.text);
    if ('schemaVersion' in attributes || 'memories' in attributes) {
      return exportDocumentSchema.parse(attributes).memories.map((record, i) => ({ record, key: record.id ?? `record:${i}`, file }));
    }
    const recognized = new Set(Object.keys(importRecordSchema.shape));
    const fields = Object.fromEntries(Object.entries(attributes).filter(([key]) => recognized.has(key)));
    const unknown = Object.fromEntries(Object.entries(attributes).filter(([key]) => !recognized.has(key)));
    const parts = attributes.id ? [{ title: null, content: body.trim(), key: String(attributes.id) }] : splitHeadings(body);
    if (!parts.length) throw new AppError('IMPORT_FAILED', 'Markdown file contains no memory content.');
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1];
    return parts.map(part => {
      const record = importRecordSchema.parse({ ...fields,
        title: part.title ?? fields.title ?? attributes.name ?? h1 ?? path.basename(file.path, path.extname(file.path)),
        content: part.content,
        source: this.id === 'claude-code' ? 'claude-code' : fields.source ?? 'markdown',
        metadata: { ...(typeof fields.metadata === 'object' && fields.metadata !== null ? fields.metadata : {}),
          ...(Object.keys(unknown).length ? { frontmatter: unknown } : {}),
          importer: this.id, importerVersion: this.version, sourcePath: file.path, sourceMtime: file.mtime, sourceHash: file.hash },
      });
      return { record, key: part.key, file };
    });
  }
}
