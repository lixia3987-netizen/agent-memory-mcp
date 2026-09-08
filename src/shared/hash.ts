import { createHash } from 'node:crypto';

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const normalizeContent = (content: string): string => content.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const contentHash = (namespace: string, project: string | null, content: string): string =>
  sha256(JSON.stringify([namespace, project, normalizeContent(content)]));
