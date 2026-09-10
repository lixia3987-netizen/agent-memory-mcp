export const phase2Migrations = [
  { version: 101, name: 'entities_relations_temporal', sql: `
    CREATE TABLE entities(id TEXT PRIMARY KEY, namespace TEXT NOT NULL, project TEXT, type TEXT NOT NULL,
      name TEXT NOT NULL, canonical_name TEXT NOT NULL, attributes_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE UNIQUE INDEX idx_entity_identity ON entities(namespace,coalesce(project,''),type,canonical_name) WHERE deleted_at IS NULL;
    CREATE INDEX idx_entity_scope ON entities(namespace,project,name);
    CREATE TABLE entity_aliases(entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL, PRIMARY KEY(entity_id,normalized_alias));
    CREATE INDEX idx_alias_name ON entity_aliases(normalized_alias);
    CREATE TABLE relations(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,project TEXT,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),predicate TEXT NOT NULL,target_entity_id TEXT NOT NULL REFERENCES entities(id),
      attributes_json TEXT,confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      source_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,source_content_hash TEXT,
      valid_from INTEGER NOT NULL,valid_to INTEGER,superseded_by TEXT REFERENCES relations(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN('active','inactive','conflict','superseded')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,
      CHECK(valid_to IS NULL OR valid_to>valid_from));
    CREATE INDEX idx_relation_source ON relations(namespace,project,source_entity_id,predicate);
    CREATE INDEX idx_relation_target ON relations(namespace,project,target_entity_id,predicate);
    CREATE INDEX idx_relation_time ON relations(valid_from,valid_to,status);
    CREATE INDEX idx_relation_memory ON relations(source_memory_id);
    CREATE TABLE memory_entities(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,role TEXT NOT NULL DEFAULT 'mentions',confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      PRIMARY KEY(memory_id,entity_id,role));
    CREATE INDEX idx_memory_entity_reverse ON memory_entities(entity_id,memory_id);
    CREATE TRIGGER protect_linked_memory_scope BEFORE UPDATE OF namespace,project ON memories
      WHEN (new.namespace<>old.namespace OR new.project IS NOT old.project) AND
      (EXISTS(SELECT 1 FROM memory_entities WHERE memory_id=old.id) OR EXISTS(SELECT 1 FROM relations WHERE source_memory_id=old.id))
      BEGIN SELECT RAISE(ABORT,'Linked memory cannot move scopes'); END;
  ` },
  { version: 102, name: 'vectors_enrichment_jobs_merges', sql: `
    CREATE TABLE memory_embeddings(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,provider TEXT NOT NULL,model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions>0),vector BLOB NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(memory_id,provider,model),CHECK(length(vector)=dimensions*4));
    CREATE TABLE memory_enrichments(memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,model TEXT NOT NULL,content_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER NOT NULL,applied_at INTEGER);
    CREATE TABLE enrichment_jobs(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,lease_until INTEGER,lease_token TEXT,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(memory_id,content_hash));
    CREATE INDEX idx_job_pending ON enrichment_jobs(status,lease_until,updated_at);
    CREATE TABLE memory_merges(id TEXT PRIMARY KEY,target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,target_before_json TEXT NOT NULL,source_before_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER invalidate_memory_derived AFTER UPDATE OF content_hash ON memories WHEN new.content_hash<>old.content_hash BEGIN
      DELETE FROM memory_embeddings WHERE memory_id=new.id;
      DELETE FROM memory_enrichments WHERE memory_id=new.id;
      UPDATE enrichment_jobs SET status='stale',lease_until=NULL,lease_token=NULL,updated_at=new.updated_at WHERE memory_id=new.id AND content_hash<>new.content_hash;
    END;
  ` },
  { version: 103, name: 'local_metrics', sql: `
    CREATE TABLE tool_metrics(tool TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0,errors INTEGER NOT NULL DEFAULT 0,
      total_ms REAL NOT NULL DEFAULT 0,max_ms REAL NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
    CREATE TABLE import_metrics(id INTEGER PRIMARY KEY AUTOINCREMENT,importer TEXT NOT NULL,stats_json TEXT NOT NULL,created_at INTEGER NOT NULL);
  ` },
  { version: 104, name: 'derived_graph_lifecycle', sql: `
    CREATE TRIGGER invalidate_enriched_links AFTER UPDATE OF content_hash ON memories WHEN new.content_hash<>old.content_hash BEGIN
      DELETE FROM memory_entities WHERE memory_id=new.id AND role='enriched';
    END;
    CREATE TRIGGER retire_facts_before_memory_purge BEFORE DELETE ON memories BEGIN
      UPDATE relations SET deleted_at=coalesce(deleted_at,CAST(unixepoch('subsec')*1000 AS INTEGER)),updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE source_memory_id=old.id;
    END;
  ` },
  { version: 105, name: 'covering_memory_stats', sql: `
    CREATE INDEX idx_memory_stats ON memories(namespace,project,deleted_at,expires_at,id,content_hash);
  ` },
] as const;
