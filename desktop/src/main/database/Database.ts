import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';

export class Database {
  private db: SqlDatabase | null = null;
  private sql: SqlJsStatic | null = null;

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    this.sql = await initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = fs.existsSync(this.filePath)
      ? new this.sql.Database(fs.readFileSync(this.filePath))
      : new this.sql.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.persist();
  }

  connection(): SqlDatabase {
    if (!this.db) throw new Error('Database is not initialized');
    return this.db;
  }

  mutate(sql: string, params: Record<string, string | number | null> = {}): void {
    this.connection().run(sql, params);
    this.persist();
  }

  transaction(work: (db: SqlDatabase) => void): void {
    const db = this.connection();
    db.run('BEGIN TRANSACTION');
    try {
      work(db);
      db.run('COMMIT');
      this.persist();
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  all<T>(sql: string, params: Record<string, string | number | null> = {}): T[] {
    const statement = this.connection().prepare(sql, params);
    const rows: T[] = [];
    while (statement.step()) rows.push(statement.getAsObject() as T);
    statement.free();
    return rows;
  }

  get<T>(sql: string, params: Record<string, string | number | null> = {}): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  close(): void {
    if (!this.db) return;
    this.persist();
    this.db.close();
    this.db = null;
  }

  private persist(): void {
    if (!this.db) return;
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(this.db.export()));
    this.replaceWithRetry(temporaryPath);
  }

  private replaceWithRetry(temporaryPath: string): void {
    const retryable = new Set(['EACCES', 'EBUSY', 'EPERM']);
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, this.filePath);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !retryable.has(code) || attempt >= 5) throw error;

        // Windows security/indexing tools can briefly hold the destination file.
        // Keep the atomic replace operation and retry instead of deleting it first.
        const delayMs = 10 * 2 ** attempt;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      }
    }
  }

  private migrate(): void {
    this.connection().run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL, company TEXT NOT NULL,
        interview_type TEXT NOT NULL, language TEXT NOT NULL, answer_style TEXT NOT NULL,
        answer_length TEXT NOT NULL, job_description TEXT NOT NULL, resume_text TEXT NOT NULL,
        instructions TEXT NOT NULL, selected_model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        mime_type TEXT NOT NULL, text TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, document_id TEXT NOT NULL, document_type TEXT NOT NULL,
        section TEXT NOT NULL, page INTEGER, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, token_vector TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON document_chunks(session_id, document_type);
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL, intent TEXT NOT NULL,
        confidence REAL NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, question_id TEXT NOT NULL, text TEXT NOT NULL,
        model TEXT NOT NULL, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(question_id) REFERENCES questions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_files (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL,
        text TEXT NOT NULL, size_bytes INTEGER NOT NULL, content_hash TEXT NOT NULL,
        storage_name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(category, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_library_files_category ON library_files(category, created_at);
      CREATE TABLE IF NOT EXISTS session_audio_sources (
        session_id TEXT PRIMARY KEY, source_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS screen_contexts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, context_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);
    this.ensureColumn('sessions', 'auto_answer', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('sessions', 'save_transcript', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('sessions', 'interview_url', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('sessions', 'resume_file_name', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('conversation_turns', 'source_id', 'TEXT');
    this.ensureColumn('conversation_turns', 'source_kind', 'TEXT');
    this.ensureColumn('conversation_turns', 'source_role', 'TEXT');
    this.ensureColumn('conversation_turns', 'can_trigger_answers', 'INTEGER');
    this.ensureColumn('conversation_turns', 'question_id', 'TEXT');
    // Additive, idempotent local migration. Existing source records are retained.
    const db = this.connection();
    db.run('BEGIN TRANSACTION');
    try {
      db.run(`CREATE TABLE IF NOT EXISTS interview_rounds (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, number INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, ended_at TEXT,
        state TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', context_document_id TEXT,
        UNIQUE(session_id, number), FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );`);
      this.ensureColumn('conversation_turns', 'round_id', 'TEXT REFERENCES interview_rounds(id)');
      this.ensureColumn('questions', 'round_id', 'TEXT REFERENCES interview_rounds(id)');
      db.run(`INSERT OR IGNORE INTO interview_rounds(id,session_id,number,started_at,ended_at,state)
        SELECT 'legacy-' || s.id,s.id,1,
        COALESCE((SELECT MIN(created_at) FROM (
          SELECT created_at FROM conversation_turns WHERE session_id=s.id
          UNION ALL SELECT created_at FROM questions WHERE session_id=s.id)),s.created_at),
        COALESCE((SELECT MAX(created_at) FROM (
          SELECT created_at FROM conversation_turns WHERE session_id=s.id
          UNION ALL SELECT created_at FROM questions WHERE session_id=s.id
          UNION ALL SELECT created_at FROM answers WHERE session_id=s.id)),s.updated_at),'completed'
        FROM sessions s WHERE NOT EXISTS(SELECT 1 FROM interview_rounds WHERE session_id=s.id) AND (
          EXISTS(SELECT 1 FROM conversation_turns WHERE session_id=s.id)
          OR EXISTS(SELECT 1 FROM questions WHERE session_id=s.id));
        UPDATE conversation_turns SET round_id=(SELECT id FROM interview_rounds WHERE session_id=conversation_turns.session_id ORDER BY number LIMIT 1) WHERE round_id IS NULL;
        UPDATE questions SET round_id=(SELECT id FROM interview_rounds WHERE session_id=questions.session_id ORDER BY number LIMIT 1) WHERE round_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_turns_round ON conversation_turns(session_id,round_id,created_at);
        CREATE INDEX IF NOT EXISTS idx_questions_round ON questions(session_id,round_id,created_at);
        CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id,session_id,created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_round_open ON interview_rounds(session_id) WHERE state='open';
        UPDATE interview_rounds SET state='interrupted', ended_at=COALESCE(
          (SELECT MAX(created_at) FROM (
            SELECT created_at FROM conversation_turns WHERE round_id=interview_rounds.id
            UNION ALL SELECT created_at FROM questions WHERE round_id=interview_rounds.id
            UNION ALL SELECT a.created_at FROM answers a JOIN questions q ON q.id=a.question_id WHERE q.round_id=interview_rounds.id
          )),started_at)
        WHERE state='open';`);
      db.run('COMMIT');
    } catch (error) { db.run('ROLLBACK'); throw error; }
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.connection().exec(`PRAGMA table_info(${table})`)[0];
    const names = columns ? columns.values.map((row) => String(row[1])) : [];
    if (!names.includes(column)) this.connection().run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}
