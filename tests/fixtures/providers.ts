import type { EmbeddingProvider, LlmProvider } from '../../src/infra/providers/contracts.ts';
import type { EnrichmentResult } from '../../src/domain/intelligence.ts';

export class TestEmbedding implements EmbeddingProvider {
  readonly id='test-embedding';readonly model='test-v1';calls=0;beforeReturn?:()=>void;
  dimensions() { return 3; }
  async embed(texts:string[]) {
    this.calls++;
    const result=texts.map(text=>/car|automobile|vehicle/i.test(text) ? [1,0,0] : /banana|fruit/i.test(text) ? [0,1,0] : [0,0,1]);
    this.beforeReturn?.();return result;
  }
}
export class TestLlm implements LlmProvider {
  readonly id='test-llm';readonly model='test-v1';calls=0;beforeReturn?:()=>void;
  result: unknown={summary:'Project uses SQLite',tags:['storage'],type:'decision',importance:8,
    entities:[{name:'Project',type:'Project',aliases:[]},{name:'SQLite',type:'Technology',aliases:['sqlite3']}],
    relations:[{source:'Project',predicate:'USES',target:'SQLite',confidence:.9}],conflicts:[] } satisfies EnrichmentResult;
  async structured<T>(_prompt:string,validate:(value:unknown)=>T):Promise<T> {this.calls++;this.beforeReturn?.();return validate(this.result);}
}
