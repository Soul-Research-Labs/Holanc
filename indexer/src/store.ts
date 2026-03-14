import Database from "better-sqlite3";

/** An indexed encrypted note from the privacy pool. */
export interface IndexedNote {
  commitment: string; // 32 bytes hex
  leafIndex: number;
  encryptedNote: string; // hex-encoded encrypted note bytes
  txSignature: string;
  slot: number;
  blockTime: number;
}

/**
 * NoteStore — SQLite-backed storage for indexed encrypted notes.
 *
 * Provides fast queries by leaf index range and commitment hash,
 * used by SDK clients to fetch notes for trial decryption.
 */
export class NoteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        commitment    TEXT NOT NULL UNIQUE,
        leaf_index    INTEGER NOT NULL,
        encrypted_note TEXT NOT NULL DEFAULT '',
        tx_signature  TEXT NOT NULL,
        slot          INTEGER NOT NULL,
        block_time    INTEGER NOT NULL,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_notes_leaf ON notes(leaf_index);
      CREATE INDEX IF NOT EXISTS idx_notes_slot ON notes(slot);

      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Insert a new indexed note. Ignores duplicates (by commitment). */
  insertNote(note: IndexedNote): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO notes (commitment, leaf_index, encrypted_note, tx_signature, slot, block_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      note.commitment,
      note.leafIndex,
      note.encryptedNote,
      note.txSignature,
      note.slot,
      note.blockTime,
    );
  }

  /**
   * Atomically insert notes and update the last-processed signature.
   *
   * Using a single SQLite transaction ensures that if the indexer crashes
   * mid-batch, neither the notes nor the checkpoint are committed, so on
   * restart the batch is replayed from the previous checkpoint.
   */
  insertNotesAtomic(notes: IndexedNote[], lastSignature: string): void {
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO notes (commitment, leaf_index, encrypted_note, tx_signature, slot, block_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const sigStmt = this.db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_signature', ?)",
    );

    const txn = this.db.transaction(() => {
      for (const note of notes) {
        insertStmt.run(
          note.commitment,
          note.leafIndex,
          note.encryptedNote,
          note.txSignature,
          note.slot,
          note.blockTime,
        );
      }
      sigStmt.run(lastSignature);
    });
    txn();
  }

  /** Get notes by leaf index range (inclusive). */
  getNotesByRange(fromLeaf: number, toLeaf: number): IndexedNote[] {
    const stmt = this.db.prepare(`
      SELECT commitment, leaf_index as leafIndex, encrypted_note as encryptedNote,
             tx_signature as txSignature, slot, block_time as blockTime
      FROM notes
      WHERE leaf_index >= ? AND leaf_index <= ?
      ORDER BY leaf_index ASC
    `);
    return stmt.all(fromLeaf, toLeaf) as IndexedNote[];
  }

  /** Get all notes after a given leaf index. */
  getNotesAfter(fromLeaf: number, limit = 1000): IndexedNote[] {
    const stmt = this.db.prepare(`
      SELECT commitment, leaf_index as leafIndex, encrypted_note as encryptedNote,
             tx_signature as txSignature, slot, block_time as blockTime
      FROM notes
      WHERE leaf_index >= ?
      ORDER BY leaf_index ASC
      LIMIT ?
    `);
    return stmt.all(fromLeaf, limit) as IndexedNote[];
  }

  /** Get a single note by commitment hash. */
  getNoteByCommitment(commitment: string): IndexedNote | undefined {
    const stmt = this.db.prepare(`
      SELECT commitment, leaf_index as leafIndex, encrypted_note as encryptedNote,
             tx_signature as txSignature, slot, block_time as blockTime
      FROM notes
      WHERE commitment = ?
    `);
    return stmt.get(commitment) as IndexedNote | undefined;
  }

  /** Total number of indexed notes. */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM notes").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  /** Highest indexed leaf index. */
  maxLeafIndex(): number {
    const row = this.db
      .prepare("SELECT MAX(leaf_index) as mx FROM notes")
      .get() as { mx: number | null };
    return row.mx ?? -1;
  }

  /** Get last processed transaction signature (for resume). */
  getLastSignature(): string | null {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'last_signature'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Set last processed transaction signature. */
  setLastSignature(sig: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_signature', ?)",
      )
      .run(sig);
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }
}
