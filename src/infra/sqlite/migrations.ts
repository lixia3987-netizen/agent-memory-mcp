import { phase2Migrations } from './phase2-migrations.ts';
export const migrations = [
  { version: 1, name: 'memory_core', sql: `
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, namespace TEXT NOT NULL, project TEXT, type TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL CHECK(length(trim(content)) > 0),
      tags_json TEXT NOT NULL DEFAULT '[]', tags_text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL, importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10),
      content_hash TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, expires_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX idx_memory_scope ON memories(namespace, project, updated_at DESC);
    CREATE INDEX idx_memory_hash ON memories(namespace, project, content_hash);
    CREATE INDEX idx_memory_type ON memories(type);
    CREATE INDEX idx_memory_source ON memories(source);
    CREATE INDEX idx_memory_expiry ON memories(expires_at);
    CREATE INDEX idx_memory_deleted ON memories(deleted_at);
  ` },
  { version: 2, name: 'full_text_indexes', sql: `
    CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags_text, project, type,
      content='memories', content_rowid='rowid', tokenize='unicode61');
    CREATE VIRTUAL TABLE memories_cjk USING fts5(title, content, tags_text, project, type,
      content='memories', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER memory_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid,title,content,tags_text,project,type) VALUES(new.rowid,new.title,new.content,new.tags_text,new.project,new.type);
      INSERT INTO memories_cjk(rowid,title,content,tags_text,project,type) VALUES(new.rowid,new.title,new.content,new.tags_text,new.project,new.type);
    END;
    CREATE TRIGGER memory_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts,rowid,title,content,tags_text,project,type) VALUES('delete',old.rowid,old.title,old.content,old.tags_text,old.project,old.type);
      INSERT INTO memories_cjk(memories_cjk,rowid,title,content,tags_text,project,type) VALUES('delete',old.rowid,old.title,old.content,old.tags_text,old.project,old.type);
    END;
    CREATE TRIGGER memory_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts,rowid,title,content,tags_text,project,type) VALUES('delete',old.rowid,old.title,old.content,old.tags_text,old.project,old.type);
      INSERT INTO memories_cjk(memories_cjk,rowid,title,content,tags_text,project,type) VALUES('delete',old.rowid,old.title,old.content,old.tags_text,old.project,old.type);
      INSERT INTO memories_fts(rowid,title,content,tags_text,project,type) VALUES(new.rowid,new.title,new.content,new.tags_text,new.project,new.type);
      INSERT INTO memories_cjk(rowid,title,content,tags_text,project,type) VALUES(new.rowid,new.title,new.content,new.tags_text,new.project,new.type);
    END;
    INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    INSERT INTO memories_cjk(memories_cjk) VALUES('rebuild');
  ` },
  { version: 3, name: 'import_provenance_and_audit', sql: `
    CREATE TABLE import_items (
      namespace TEXT NOT NULL, project_key TEXT NOT NULL, source_path TEXT NOT NULL,
      item_key TEXT NOT NULL, file_hash TEXT NOT NULL, memory_id TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY(namespace,project_key,source_path,item_key,file_hash),
      FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_import_origin ON import_items(namespace,project_key,source_path,item_key,imported_at DESC);
    CREATE TABLE audit_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
      action TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      namespace TEXT NOT NULL, project TEXT
    );
  ` },
  ...phase2Migrations,
] as const;
export const SCHEMA_VERSION = migrations.at(-1)!.version;
