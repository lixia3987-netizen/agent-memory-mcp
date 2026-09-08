import { homedir, platform } from 'node:os';
import path from 'node:path';
import { lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { AppError } from './errors.ts';

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (platform() === 'win32') return path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'AgentMemoryMCP');
  return path.join(homedir(), '.agent-memory-mcp');
}
export function expandPath(input: string): string {
  return path.resolve(input === '~' ? homedir() : /^~[/\\]/.test(input) ? path.join(homedir(), input.slice(2)) : input);
}
export function within(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}
export function safeInputPath(input: string, allowedRoots: string[]): string {
  const absolute = expandPath(input);
  // Reject symlinks/junctions in every existing component, including a supplied root.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new AppError('PERMISSION_DENIED', 'Import paths must not contain symbolic links or junctions.');
  }
  const canonical = realpathSync(absolute);
  if (allowedRoots.length && !allowedRoots.some(root => within(canonical, realpathSync(expandPath(root))))) {
    throw new AppError('PERMISSION_DENIED', 'Import path is outside the configured allowed directories.');
  }
  return canonical;
}
export function safeRead(file: string, allowedRoots: string[], maxBytes: number): { text: string; mtime: number } {
  const safe = safeInputPath(file, allowedRoots);
  const fd = openSync(safe, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new AppError('IMPORT_FAILED', 'Import input must be a regular file.');
    if (stat.size > maxBytes) throw new AppError('VALIDATION_ERROR', `Import file exceeds ${maxBytes} bytes.`);
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) throw new AppError('VALIDATION_ERROR', 'Import file grew beyond the size limit.');
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), mtime: stat.mtimeMs }; }
    catch { throw new AppError('IMPORT_FAILED', 'Input must use UTF-8 encoding.'); }
  } finally { closeSync(fd); }
}
