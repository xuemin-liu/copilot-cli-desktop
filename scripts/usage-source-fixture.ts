import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Minimal supported Copilot source for worker and packaged-runtime checks. */
export function seedSourceStore(directory: string, sessionId = 'session'): void {
  mkdirSync(directory, { recursive: true })
  const source = new DatabaseSync(join(directory, 'session-store.db'))
  try {
    source.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE assistant_usage_events(id INTEGER PRIMARY KEY,session_id TEXT,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,created_at TEXT)`)
    source.prepare('INSERT INTO assistant_usage_events VALUES(1,?,?,?,?,?,?,?)')
      .run(sessionId, 'model', 100, 20, 40, 10, '2026-09-08T00:00:00Z')
  } finally { source.close() }
}
