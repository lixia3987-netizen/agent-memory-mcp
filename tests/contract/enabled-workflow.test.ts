import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Memory } from '../../src/domain/memory.ts';
import { cleanup, temporary } from '../helpers.ts';
import { providerServer } from '../fixtures/http-provider.ts';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const execute = promisify(execFile);
type Payload = Record<string,unknown>;
const records = (value: unknown): Payload[] => { assert.ok(Array.isArray(value)); return value as Payload[]; };

async function connect(t: TestContext, config: string, db?: string) {
  const client = new Client({ name:'enabled-workflow-client',version:'1.0.0' });
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string,string] => pair[1] !== undefined));
  const transport = new StdioClientTransport({ command:process.execPath,
    args:[entry,'serve','--config',config,...(db ? ['--db',db] : [])],
    env:{ ...env,WORKFLOW_MODEL_KEY:'local-test-key-only' },stderr:'pipe' });
  await client.connect(transport);
  cleanup(t, () => client.close());
  const call = async (name: string, args: Payload = {}): Promise<Payload> => {
    const response = await client.callTool({ name,arguments:args });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.ok(response.structuredContent);
    return response.structuredContent as Payload;
  };
  return { client,call };
}

test('compiled MCP with HTTP providers indexes, enriches, restores a full backup and invalidates stale knowledge', { timeout:30000 }, async t => {
  const root = temporary(t); const home = path.join(root,'记忆 服务'); mkdirSync(home);
  let unavailable = false;
  const endpoint = await providerServer(t, (route,body) => {
    if (unavailable) return { status:503,body:{ error:'test outage' } };
    if (route === '/v1/embeddings') return { body:{ data:(body.input as string[]).map((text,index) => ({
      index,embedding:/car|automobile|vehicle/i.test(text) ? [1,0,0] : /fruit|banana/i.test(text) ? [0,1,0] : [0,0,1],
    })).reverse() } };
    assert.equal(route, '/v1/chat/completions');
    return { body:{ choices:[{ message:{ content:JSON.stringify({ summary:'Cars need parking.',tags:['transport'],importance:8,
      entities:[{ name:'Car',type:'Vehicle',aliases:['automobile'] },{ name:'Parking',type:'Place' }],
      relations:[{ source:'Car',predicate:'NEEDS',target:'Parking',confidence:0.9 }],conflicts:[],
    }) } }] } };
  });
  const config = path.join(root,'工作 配置.json');
  const provider = { enabled:true,baseUrl:endpoint.baseUrl,apiKeyEnv:'WORKFLOW_MODEL_KEY',timeoutMs:5000,retries:0 };
  writeFileSync(config, JSON.stringify({ homeDir:home,namespace:'workflow',project:null,logLevel:'error',
    embedding:{ ...provider,model:'fixture-embedding',dimensions:3 },llm:{ ...provider,model:'fixture-chat' } }));
  const initial = await connect(t, config); let { call } = initial;
  const car = (await call('memory_add',{ content:'A car needs a parking place.',tags:['transport'] })).memory as Memory;
  await call('memory_add',{ content:'A banana is a fruit.' });
  const privateCar = (await call('memory_add',{ content:'A car in another project.',project:'private' })).memory as Memory;
  assert.equal((await call('memory_reindex')).indexed, 2);
  assert.equal((await call('memory_reindex',{ project:'private' })).indexed, 1);
  assert.equal((await call('memory_reindex')).indexed, 0);
  assert.equal(records((await call('memory_search',{ query:'automobile' })).memories).length, 0);
  const semantic = await call('memory_search_hybrid',{ query:'automobile',mode:'semantic',tag:'transport' });
  assert.equal(semantic.mode, 'semantic');
  assert.deepEqual(records(semantic.memories).map(m => m.id), [car.id]);
  const across = await call('memory_search_hybrid',{ query:'automobile',mode:'semantic',all_projects:true });
  assert.deepEqual(new Set(records(across.memories).map(m => m.id)), new Set([car.id,privateCar.id]));

  const enriched = await call('memory_enrich',{ id:car.id }); assert.equal(enriched.cached, false);
  assert.equal((await call('memory_stats')).entities, 0);
  assert.equal((await call('memory_enrich',{ id:car.id })).cached, true);
  assert.equal(endpoint.requests.filter(r => r.route === '/v1/chat/completions').length, 1);
  const applied = await call('memory_enrich',{ id:car.id,action:'apply' }); assert.equal(applied.applied, true);
  assert.equal((await call('memory_enrich',{ id:car.id,action:'apply' })).already_applied, true);
  const { expired:_,...unchanged } = await call('memory_get',{ id:car.id }); assert.deepEqual(unchanged, car);
  const hybrid = await call('memory_search_hybrid',{ query:'automobile' });
  assert.equal(hybrid.mode, 'hybrid'); assert.equal(hybrid.graph_used, true);
  assert.equal(records(hybrid.memories)[0]?.id, car.id);
  const facts = records((await call('relation_search')).relations); assert.equal(facts.length, 1);
  const historicalAt = String(facts[0]!.valid_from);
  await initial.client.close();

  // Exercise the shipped recovery CLI with populated vectors, graph and enrichment.
  const cli = async (args: string[]) => JSON.parse((await execute(process.execPath,[entry,...args,'--config',config])).stdout) as Payload;
  const backup = await cli(['backup']); const restoredDb = path.join(root,'恢复 数据.db');
  assert.equal((await cli(['restore','--from',String(backup.path),'--output',restoredDb])).original_preserved, true);
  const restored = await connect(t, config, restoredDb); call = restored.call;
  const stats = await call('memory_stats');
  assert.equal(stats.embeddings, 2); assert.equal(stats.enrichments, 1); assert.equal(stats.relations, 1);
  assert.equal((await call('memory_enrich',{ id:car.id })).cached, true);
  assert.equal((await call('memory_enrich',{ id:car.id,action:'apply' })).already_applied, true);
  assert.equal(records((await call('memory_search_hybrid',{ query:'automobile',mode:'semantic' })).memories)[0]?.id, car.id);
  await call('memory_update',{ id:car.id,updates:{ content:'A banana recipe uses fruit.' } });
  assert.equal((await call('memory_enrich',{ id:car.id,action:'get' })).enrichment, null);
  assert.equal((await call('memory_stats')).embeddings, 1);
  assert.equal(records((await call('relation_search')).relations).length, 0);
  assert.equal(records((await call('memory_at_time',{ at:historicalAt })).relations).length, 1);
  const staleApply = await restored.client.callTool({ name:'memory_enrich',arguments:{ id:car.id,action:'apply' } });
  assert.equal(staleApply.isError, true);
  assert.equal((await call('memory_reindex')).indexed, 1);
  assert.equal(records((await call('memory_search_hybrid',{ query:'automobile',mode:'semantic' })).memories).length, 0);

  // A provider outage must still leave the original lexical service usable.
  unavailable = true;
  const fallback = await call('memory_search_hybrid',{ query:'banana' });
  assert.equal(fallback.mode, 'lexical'); assert.equal(records(fallback.memories).length, 2);
  assert.equal((fallback.fallback as Payload).code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await call('memory_maintenance',{ action:'graph-check' })).invalid_relations, 0);
  await restored.client.close();
  const original = await connect(t, config);
  assert.equal((await original.call('memory_get',{ id:car.id })).content, car.content);
  assert.ok(endpoint.requests.every(r => r.authorization === 'Bearer local-test-key-only'));
  assert.ok(!readFileSync(restoredDb).includes('local-test-key-only'));
});
