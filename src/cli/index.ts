import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../app/bootstrap.ts';
import { resolveConfig } from '../app/config.ts';
import { restoreDatabase } from '../services/backup-service.ts';
import { serveStdio } from '../mcp/server.ts';
import { serveHttp } from '../mcp/http.ts';
import { VERSION } from '../shared/version.ts';
import { AppError, errorResult } from '../shared/errors.ts';

const help = `Agent Memory MCP ${VERSION} — Node.js 24

Commands:
  serve                         MCP stdio server (default)
  init | migrate | doctor       Initialize, migrate, or diagnose database
  add --content TEXT            Add a memory (also --title, --type, --source)
  list | search --query TEXT     Browse or search memories
  import --format FORMAT --path PATH [--dry-run | --apply] [--conflict skip|update|copy] [--backup]
  export --format json|markdown --output FILE
  backup                        Create a verified snapshot
  restore --id ID                Restore a soft-deleted memory
  restore --from FILE --output NEW_DB
                                Verify backup and restore to a NEW database path
  stats                         Counts for the selected scope
  importers                     List registered importer adapters
  reindex [--limit N]            Build configured embeddings for this scope
  enrich --id ID [--action run|get|apply|enqueue]
  maintenance --action ACTION [--apply] [--limit N] [--id ID]
                                expire/orphans/fts-rebuild/graph-check/embeddings/enrichment-jobs/duplicates/vacuum/stats
  purge --before ISO_TIME --yes  Permanently delete soft-deleted memories before cutoff

Global options: --home DIR --db FILE --config FILE --namespace NAME --project NAME
                --no-project --log-level error|warn|info|debug
                serve --transport stdio|http (HTTP also requires config and token)
Filters: --type TYPE --source NAME --tag TAG --limit N --offset N
         --all-projects --include-expired --include-deleted
         --created-after ISO_TIME --created-before ISO_TIME

Imports preview by default. Use --apply to persist. Exports never overwrite files.
Run help for this message. Read README.md for Windows and client configuration.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, home: { type: 'string' }, db: { type: 'string' }, config: { type: 'string' },
    namespace: { type: 'string' }, project: { type: 'string' }, 'no-project': { type: 'boolean' }, 'log-level': { type: 'string' },
    format: { type: 'string' }, path: { type: 'string' }, 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' },
    conflict: { type: 'string' }, backup: { type: 'boolean' }, output: { type: 'string' }, from: { type: 'string' }, id: { type: 'string' },
    before: { type: 'string' }, yes: { type: 'boolean' }, type: { type: 'string' }, source: { type: 'string' }, tag: { type: 'string' },
    'all-projects': { type: 'boolean' }, 'include-expired': { type: 'boolean' }, 'include-deleted': { type: 'boolean' },
    'created-after': { type: 'string' }, 'created-before': { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' },
    query: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' },
    action:{ type:'string' },transport:{ type:'string' },mode:{ type:'string' },'after-id':{type:'string'},force:{type:'boolean'},
  } });
  const command = positionals[0] ?? 'serve';
  if (v.help || command === 'help') { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new AppError('VALIDATION_ERROR', 'Unexpected positional arguments. Use --path for file paths.');
  if (!['serve', 'init', 'migrate', 'doctor', 'add', 'list', 'search', 'import', 'export', 'backup', 'restore', 'stats', 'purge','importers','reindex','enrich','maintenance'].includes(command)) throw new AppError('VALIDATION_ERROR', 'Unknown command. Run help.');
  if (v.transport && !['stdio','http'].includes(v.transport)) throw new AppError('VALIDATION_ERROR','Transport must be stdio or http.');
  if (v.project && v['no-project']) throw new AppError('VALIDATION_ERROR', 'Choose --project or --no-project.');
  if (v.apply && v['dry-run']) throw new AppError('VALIDATION_ERROR', 'Choose --apply or --dry-run.');
  const overrides = { homeDir: v.home, dbPath: v.db, config: v.config, namespace: v.namespace,
    project: v['no-project'] ? null : v.project, logLevel: v['log-level'] as 'info' | undefined };
  // File recovery bypasses ordinary database startup so a corrupt current DB
  // cannot prevent restoring a known-good backup into a different path.
  if (command === 'restore' && v.from && v.output && !v.id) {
    const result = await restoreDatabase(resolveConfig(overrides), v.from, v.output);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return;
  }
  const app = await bootstrap(overrides);
  const scope = { namespace: v.namespace, project: v['no-project'] ? null : v.project };
  const filters = { ...scope, type: v.type, source: v.source, tag: v.tag, all_projects: v['all-projects'],
    include_expired: v['include-expired'], include_deleted: v['include-deleted'],
    created_after: v['created-after'], created_before: v['created-before'] };
  const pagination = { limit: v.limit === undefined ? undefined : Number(v.limit), offset: v.offset === undefined ? undefined : Number(v.offset) };
  if (command === 'serve') {
    try {
      if (v.transport==='http') {
        const listener=await serveHttp(app);
        process.stderr.write(JSON.stringify({ event:'http.ready',url:listener.url })+'\n');
        let closing=false;const close=()=>{ if (!closing) { closing=true;void listener.close().finally(()=>app.close()); } };
        process.once('SIGINT',close);process.once('SIGTERM',close);
      } else await serveStdio(app);
    } catch (error) { app.close(); throw error; }
    return;
  }
  let result: unknown;
  try {
    switch (command) {
      case 'init': case 'migrate': case 'doctor': result = app.doctor(); break;
      case 'add': result = app.memory.add({ ...scope, content: v.content, title: v.title, type: v.type, source: v.source }); break;
      case 'list': result = app.memory.list({ ...filters, ...pagination }); break;
      case 'search': result = v.mode ? await app.hybrid.search({ ...filters,...pagination,query:v.query,mode:v.mode }) : await app.memory.searchAsync({ ...filters, ...pagination, query: v.query }); break;
      case 'import': result = await app.imports.run({ ...scope, format: v.format, path: v.path, dry_run: !v.apply, conflict: v.conflict, backup: v.backup });
        try { app.intelligence.recordGlobalImportMetrics(v.format ?? 'unknown',result); }catch { app.log('warn','metrics.unavailable'); }break;
      case 'importers': result={ importers:app.imports.listAdapters() };break;
      case 'reindex': result=await app.embeddings.rebuild({ ...scope,limit:pagination.limit,after_id:v['after-id'],force:v.force });break;
      case 'enrich': result=await app.enrichment.run({ ...scope,id:v.id,action:v.action ?? 'run' });break;
      case 'maintenance': result=await app.maintenance.run({ ...scope,action:v.action,dry_run:!v.apply,limit:pagination.limit,id:v.id,after_id:v['after-id'] });break;
      case 'export': {
        if (!v.output) throw new AppError('VALIDATION_ERROR', 'export requires --output FILE.');
        const exported = app.exports.run({ ...filters, format: v.format ?? 'json' });
        const output = path.resolve(v.output); mkdirSync(path.dirname(output), { recursive: true });
        writeFileSync(output, exported.data, { encoding: 'utf8', flag: 'wx' });
        result = { output, count: exported.count, schemaVersion: exported.schemaVersion }; break;
      }
      case 'backup': result = { path: await app.backups.create() }; break;
      case 'restore':
        if (v.id && !v.from && !v.output) result = app.memory.restore({ ...scope, id: v.id });
        else throw new AppError('VALIDATION_ERROR', 'Use restore --id ID, or restore --from BACKUP --output NEW_DB.');
        break;
      case 'stats': result = { ...app.maintenance.stats(scope), dbBytes: app.backups.size() }; break;
      case 'purge':
        if (!v.yes || !v.before) throw new AppError('VALIDATION_ERROR', 'purge requires --yes and --before ISO_TIME. It permanently removes only soft-deleted memories.');
        result = app.memory.purge({ ...filters, before:v.before, confirmed:v.yes }); break;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await app.close(); }
}
export function reportFailure(error: unknown): void {
  // CLI errors go to stderr so a failed stdio startup never corrupts stdout.
  process.stderr.write(JSON.stringify(errorResult(error)) + '\n'); process.exitCode = 1;
}
