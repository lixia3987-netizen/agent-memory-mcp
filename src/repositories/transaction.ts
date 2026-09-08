/** Transaction callbacks must finish synchronously and must not schedule work. */
export type SyncOperation<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown);
