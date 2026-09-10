import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../../app/config.ts';
import type { Filters, SearchHit } from '../../domain/memory.ts';
import type { AsyncSearch } from '../../repositories/async-search.ts';
import { AppError } from '../../shared/errors.ts';

type Job = { id: number; query: string; filters: Filters; now: number; timer: NodeJS.Timeout;
  resolve: (hits: SearchHit[]) => void; reject: (error: AppError) => void; settled: boolean };
/** One lazy read-only connection, one executing job, and a bounded total budget. */
export class SqliteAsyncSearch implements AsyncSearch {
  private config: Pick<AppConfig, 'dbPath' | 'busyTimeoutMs' | 'search'>;
  private worker?: Worker;
  private current?: Job;
  private queue: Job[] = [];
  private sequence = 0;
  private stopping = false;
  private closing?: Promise<void>;
  private closed?: () => void;
  private terminating = false;
  constructor(config: Pick<AppConfig, 'dbPath' | 'busyTimeoutMs' | 'search'>) {
    this.config = { dbPath: config.dbPath, busyTimeoutMs: config.busyTimeoutMs, search: config.search };
  }
  search(query: string, filters: Filters, now: number): Promise<SearchHit[]> {
    if (this.stopping) return Promise.reject(new AppError('DATABASE_BUSY', 'Search executor is closing.'));
    if (this.queue.length + Number(!!this.current) >= this.config.search.workerQueueLimit) {
      return Promise.reject(new AppError('DATABASE_BUSY', 'Search capacity is full. Retry after current searches finish.', true));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.sequence, query, filters: structuredClone(filters), now, resolve, reject, settled: false,
        timer: setTimeout(() => this.timeout(job), this.config.search.workerTimeoutMs) };
      this.queue.push(job); this.dispatch();
    });
  }
  private settle(job: Job, error?: AppError, hits: SearchHit[] = []): void {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.timer);
    if (error) job.reject(error); else job.resolve(hits);
  }
  private timeout(job: Job): void {
    this.settle(job, new AppError('DATABASE_BUSY', 'Search exceeded its queue/execution deadline. Retry with narrower filters.', true));
    if (this.current === job) {
      // Native SQLite may need time to exit. Retain its slot and do not spawn a
      // replacement until exit confirms the old worker has actually stopped.
      this.terminating = true; void this.worker!.terminate().catch(() => {});
    } else { this.queue = this.queue.filter(item => item !== job); this.dispatch(); }
  }
  private start(): void {
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = new Worker(new URL(`./search-worker.${extension}`, import.meta.url), { workerData: this.config });
    this.worker = worker;
    worker.on('message', (message: { id: number; hits?: SearchHit[]; error?: { code: AppError['code']; message: string; retryable: boolean } }) => {
      if (this.worker !== worker || this.terminating || message.id !== this.current?.id) return;
      const job = this.current!; this.current = undefined;
      this.settle(job, message.error ? new AppError(message.error.code, message.error.message, message.error.retryable) : undefined, message.hits);
      this.dispatch();
    });
    worker.on('error', () => {
      if (this.worker === worker) {
        this.terminating = true;
        if (this.current) this.settle(this.current, new AppError('INTERNAL_ERROR', 'Search worker failed. Run doctor and retry.', true));
      }
    });
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      if (this.current) this.settle(this.current, new AppError('INTERNAL_ERROR', 'Search worker stopped before returning a result.', true));
      this.current = undefined; this.worker = undefined; this.terminating = false;
      this.dispatch();
    });
  }
  private dispatch(): void {
    if (this.current || this.terminating) return;
    const job = this.queue.shift();
    if (job) {
      this.current = job;
      try {
        if (!this.worker) this.start();
        this.worker!.postMessage({ type: 'search', id: job.id, query: job.query, filters: job.filters, now: job.now });
      } catch {
        this.settle(job, new AppError('INTERNAL_ERROR', 'Unable to start search worker.', true));
        this.current = undefined;
        if (this.worker) { this.terminating = true; void this.worker.terminate().catch(() => {}); }
        else this.dispatch();
      }
    } else if (this.stopping) {
      if (this.worker) { this.terminating = true; this.worker.postMessage({ type: 'close' }); }
      else this.closed?.();
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.stopping = true;
      this.closing = new Promise(resolve => { this.closed = resolve; });
      this.dispatch();
    }
    return this.closing;
  }
}
