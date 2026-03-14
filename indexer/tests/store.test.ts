import { NoteStore, IndexedNote } from "../src/store";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function tmpDb(): string {
  return path.join(os.tmpdir(), `holanc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    commitment: `0x${Math.random().toString(16).slice(2)}`,
    leafIndex: 0,
    encryptedNote: "deadbeef",
    txSignature: "sig123",
    slot: 100,
    blockTime: 1700000000,
    ...overrides,
  };
}

describe("NoteStore", () => {
  let dbPath: string;
  let store: NoteStore;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new NoteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  // -- insertNote / count ---------------------------------------------------

  it("starts empty", () => {
    expect(store.count()).toBe(0);
    expect(store.maxLeafIndex()).toBe(-1);
  });

  it("inserts a note and increments count", () => {
    store.insertNote(makeNote({ leafIndex: 0 }));
    expect(store.count()).toBe(1);
  });

  it("ignores duplicate commitments", () => {
    const note = makeNote({ commitment: "dup" });
    store.insertNote(note);
    store.insertNote(note);
    expect(store.count()).toBe(1);
  });

  // -- getNotesByRange ------------------------------------------------------

  it("returns notes within leaf index range (inclusive)", () => {
    for (let i = 0; i < 10; i++) {
      store.insertNote(makeNote({ leafIndex: i, commitment: `c${i}` }));
    }
    const result = store.getNotesByRange(3, 6);
    expect(result).toHaveLength(4);
    expect(result[0].leafIndex).toBe(3);
    expect(result[3].leafIndex).toBe(6);
  });

  it("returns empty array when range has no notes", () => {
    store.insertNote(makeNote({ leafIndex: 5, commitment: "c5" }));
    expect(store.getNotesByRange(10, 20)).toHaveLength(0);
  });

  // -- getNotesAfter --------------------------------------------------------

  it("returns notes after a given leaf index with limit", () => {
    for (let i = 0; i < 20; i++) {
      store.insertNote(makeNote({ leafIndex: i, commitment: `c${i}` }));
    }
    const result = store.getNotesAfter(10, 5);
    expect(result).toHaveLength(5);
    expect(result[0].leafIndex).toBe(10);
  });

  // -- getNoteByCommitment --------------------------------------------------

  it("finds a note by commitment", () => {
    store.insertNote(makeNote({ commitment: "target", leafIndex: 7 }));
    const found = store.getNoteByCommitment("target");
    expect(found).toBeDefined();
    expect(found!.leafIndex).toBe(7);
  });

  it("returns undefined for unknown commitment", () => {
    expect(store.getNoteByCommitment("missing")).toBeUndefined();
  });

  // -- maxLeafIndex ---------------------------------------------------------

  it("tracks the maximum leaf index", () => {
    store.insertNote(makeNote({ leafIndex: 3, commitment: "a" }));
    store.insertNote(makeNote({ leafIndex: 9, commitment: "b" }));
    store.insertNote(makeNote({ leafIndex: 5, commitment: "c" }));
    expect(store.maxLeafIndex()).toBe(9);
  });

  // -- metadata: last signature ---------------------------------------------

  it("returns null when no last signature is set", () => {
    expect(store.getLastSignature()).toBeNull();
  });

  it("persists and retrieves last signature", () => {
    store.setLastSignature("abc123");
    expect(store.getLastSignature()).toBe("abc123");
  });

  it("overwrites last signature on subsequent calls", () => {
    store.setLastSignature("first");
    store.setLastSignature("second");
    expect(store.getLastSignature()).toBe("second");
  });
});
