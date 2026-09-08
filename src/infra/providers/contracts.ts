// Network-free by default. Implementations are created only through explicit configuration.
export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  dimensions(): number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  structured<T>(prompt: string, validate: (output: unknown) => T, signal?: AbortSignal): Promise<T>;
}
