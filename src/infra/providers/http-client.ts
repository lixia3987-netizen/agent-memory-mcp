import type { ProviderConfig } from '../../domain/phase2-config.ts';
import { AppError } from '../../shared/errors.ts';

export class ProviderHttpClient {
  private config: ProviderConfig; private failures=0; private openUntil=0;
  constructor(config: ProviderConfig) { this.config=config; }
  async post(route: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (Date.now()<this.openUntil) throw new AppError('PROVIDER_UNAVAILABLE','Provider circuit is temporarily open. Retry after cooldown.',true);
    let lastRetryable=true;
    for (let attempt=0;attempt<=this.config.retries;attempt++) {
      if (signal?.aborted) throw new AppError('PROVIDER_UNAVAILABLE','Provider request was cancelled.',true);
      try {
        const key=this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv] : undefined;
        const response=await fetch(this.config.baseUrl!.replace(/\/+$/,'')+'/'+route,{
          method:'POST',headers:{ 'Content-Type':'application/json',...(key ? { Authorization:`Bearer ${key}` } : {}) },body:JSON.stringify(body),
          redirect:'error',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs),
        });
        if (!response.ok) {
          lastRetryable=response.status===429 || response.status>=500;
          await response.body?.cancel();
          throw new AppError('PROVIDER_UNAVAILABLE',`Provider returned HTTP ${response.status}. Check endpoint, credentials, model and service availability.`,lastRetryable);
        }
        const reader=response.body?.getReader(); if (!reader) throw new AppError('PROVIDER_UNAVAILABLE','Provider returned an empty response.');
        const chunks: Uint8Array[]=[];let size=0;
        try {
          while (true) { const part=await reader.read();if (part.done) break;size+=part.value.length;
            if (size>this.config.maxResponseBytes) { await reader.cancel();throw new AppError('PROVIDER_UNAVAILABLE','Provider response exceeds the size limit.'); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        let value: unknown;
        try { value=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new AppError('PROVIDER_UNAVAILABLE','Provider response is not valid JSON.'); }
        this.failures=0;this.openUntil=0;return value;
      } catch (error) {
        const safe=error instanceof AppError ? error : new AppError('PROVIDER_UNAVAILABLE','Provider request failed or timed out. Check the configured endpoint.',true);
        lastRetryable=safe.retryable;
        if (!lastRetryable || attempt===this.config.retries || signal?.aborted) {
          // A bad request/key is not an outage, and caller cancellation is not
          // evidence of provider failure. Only exhausted transient failures count.
          if (safe.retryable && !signal?.aborted && ++this.failures>=this.config.circuitFailures) this.openUntil=Date.now()+this.config.circuitCooldownMs;
          throw safe;
        }
        await new Promise<void>(resolve => setTimeout(resolve,Math.min(1000,100*2**attempt)));
      }
    }
    throw new AppError('PROVIDER_UNAVAILABLE','Provider request failed.',lastRetryable);
  }
}
