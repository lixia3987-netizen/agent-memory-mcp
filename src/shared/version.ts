import { readFileSync } from 'node:fs';

// src/shared and dist/shared have the same depth relative to the package root.
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
export const VERSION = manifest.version;
