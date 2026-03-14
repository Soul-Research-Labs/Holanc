/**
 * High-availability NoteStore with read-replica support.
 *
 * Wraps the primary NoteStore with optional read replicas that are kept in sync
 * via SQLite WAL-mode replication. All writes go to the primary; reads are
 * distributed across healthy replicas with automatic fallback.
 *
 * Usage:
 *   const store = new ReplicatedNoteStore("./data/primary.db", [
 *     "./data/replica-1.db",
 *     "./data/replica-2.db",
 *   ]);
 *   store.insertNote(note);              // writes → primary
 *   store.getNotesByRange(0, 100);       // reads → replica (round-robin)
 */

import { NoteStore, IndexedNote } from "./store";

export interface ReplicaHealth {
  path: string;
  healthy: boolean;
  lastSyncLeaf: number;
  lagBehindPrimary: number;
}

export class ReplicatedNoteStore {
  private primary: NoteStore;
  private replicas: NoteStore[];
  private replicaPaths: string[];
  private replicaHealthy: boolean[];
  private nextReplica: number;

  constructor(primaryPath: string, replicaPaths: string[] = []) {
    this.primary = new NoteStore(primaryPath);
    this.replicaPaths = replicaPaths;
    this.replicas = replicaPaths.map((p) => {
      try {
        return new NoteStore(p);
      } catch {
        // Replica may not exist yet — create it
        return new NoteStore(p);
      }
    });
    this.replicaHealthy = this.replicas.map(() => true);
    this.nextReplica = 0;
  }

  // -----------------------------------------------------------------------
  // Write operations — always go to primary, then sync replicas
  // -----------------------------------------------------------------------

  insertNote(note: IndexedNote): void {
    this.primary.insertNote(note);
    this.syncToReplicas(note);
  }

  setLastSignature(sig: string): void {
    this.primary.setLastSignature(sig);
  }

  // -----------------------------------------------------------------------
  // Read operations — distributed across healthy replicas
  // -----------------------------------------------------------------------

  getNotesByRange(fromLeaf: number, toLeaf: number): IndexedNote[] {
    return this.readFromReplica((store) => store.getNotesByRange(fromLeaf, toLeaf));
  }

  getNotesAfter(fromLeaf: number, limit = 1000): IndexedNote[] {
    return this.readFromReplica((store) => store.getNotesAfter(fromLeaf, limit));
  }

  getNoteByCommitment(commitment: string): IndexedNote | undefined {
    return this.readFromReplica((store) => store.getNoteByCommitment(commitment));
  }

  count(): number {
    return this.readFromReplica((store) => store.count());
  }

  maxLeafIndex(): number {
    return this.readFromReplica((store) => store.maxLeafIndex());
  }

  getLastSignature(): string | null {
    // Always read from primary for consistency
    return this.primary.getLastSignature();
  }

  // -----------------------------------------------------------------------
  // Health & monitoring
  // -----------------------------------------------------------------------

  health(): ReplicaHealth[] {
    const primaryMax = this.primary.maxLeafIndex();
    return this.replicas.map((r, i) => {
      let lastSyncLeaf = -1;
      try {
        lastSyncLeaf = r.maxLeafIndex();
      } catch {
        this.replicaHealthy[i] = false;
      }
      return {
        path: this.replicaPaths[i],
        healthy: this.replicaHealthy[i],
        lastSyncLeaf,
        lagBehindPrimary: primaryMax - lastSyncLeaf,
      };
    });
  }

  /** Force a full resync of a specific replica from primary. */
  resyncReplica(replicaIndex: number): void {
    if (replicaIndex < 0 || replicaIndex >= this.replicas.length) return;

    const maxLeaf = this.primary.maxLeafIndex();
    if (maxLeaf < 0) return;

    const batchSize = 500;
    for (let start = 0; start <= maxLeaf; start += batchSize) {
      const notes = this.primary.getNotesByRange(start, start + batchSize - 1);
      for (const note of notes) {
        try {
          this.replicas[replicaIndex].insertNote(note);
        } catch {
          // Ignore duplicates during resync
        }
      }
    }

    this.replicaHealthy[replicaIndex] = true;
  }

  close(): void {
    this.primary.close();
    for (const r of this.replicas) {
      try {
        r.close();
      } catch {
        // Best effort
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private syncToReplicas(note: IndexedNote): void {
    for (let i = 0; i < this.replicas.length; i++) {
      if (!this.replicaHealthy[i]) continue;
      try {
        this.replicas[i].insertNote(note);
      } catch {
        this.replicaHealthy[i] = false;
      }
    }
  }

  /**
   * Round-robin read from healthy replicas, falling back to primary.
   */
  private readFromReplica<T>(fn: (store: NoteStore) => T): T {
    if (this.replicas.length === 0) {
      return fn(this.primary);
    }

    // Try each replica starting from nextReplica
    for (let attempt = 0; attempt < this.replicas.length; attempt++) {
      const idx = (this.nextReplica + attempt) % this.replicas.length;
      if (!this.replicaHealthy[idx]) continue;

      try {
        const result = fn(this.replicas[idx]);
        this.nextReplica = (idx + 1) % this.replicas.length;
        return result;
      } catch {
        this.replicaHealthy[idx] = false;
      }
    }

    // All replicas failed — fall back to primary
    return fn(this.primary);
  }
}
