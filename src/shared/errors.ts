import { ZodError } from 'zod';

export type ErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'DATABASE_BUSY'
  | 'DATABASE_CORRUPT' | 'MIGRATION_FAILED' | 'IMPORT_FAILED' | 'PROVIDER_UNAVAILABLE'
  | 'PERMISSION_DENIED' | 'UNSUPPORTED_FORMAT' | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  const e = error as { code?: string; errcode?: number; message?: string };
  if (e?.code?.startsWith('ERR_PARSE_ARGS')) return new AppError('VALIDATION_ERROR', 'Invalid command-line arguments. Run help for supported options.');
  if ([5, 6].includes((e?.errcode ?? -1) & 255) || /database (is locked|is busy)/i.test(e?.message ?? '')) {
    return new AppError('DATABASE_BUSY', 'Database is busy. Retry after other writes or maintenance finish.', true);
  }
  if ([11, 26].includes((e?.errcode ?? -1) & 255)) return new AppError('DATABASE_CORRUPT', 'SQLite integrity failed. Use a verified backup in a new database path.');
  if (['EACCES', 'EPERM', 'ELOOP'].includes(e?.code ?? '')) return new AppError('PERMISSION_DENIED', 'Check path permissions and remove symbolic links.');
  if (e?.code === 'ENOENT') return new AppError('NOT_FOUND', 'The specified file or directory does not exist.');
  if (e?.code === 'EEXIST') return new AppError('CONFLICT', 'Output already exists. Choose a new output path.');
  if (((e?.errcode ?? -1) & 255) === 19) return new AppError('CONFLICT', 'A database constraint rejected this change. Check IDs and duplicate content.');
  return new AppError('INTERNAL_ERROR', 'Operation failed. Run doctor and check configuration and file permissions.');
}

export function errorResult(error: unknown) {
  const e = asAppError(error);
  return { error: { code: e.code, message: e.message, retryable: e.retryable } };
}
