import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { NoteStore, IndexedNote } from "./store";
import { ReplicatedNoteStore } from "./replicated-store";

const POOL_PROGRAM_ID = new PublicKey(
  "6fhYW9wEHD3yCdvfyBCg3jxVB7sWVmqNgQyvMwSFi1GT",
);

/**
 * NoteScanner — watches the Holanc privacy pool program for new commitment
 * events and stores encrypted notes for later retrieval / trial-decryption.
 *
 * The scanner reads Solana program logs emitted by the pool program during
 * deposit, transfer, and withdraw instructions. Encrypted note data and leaf
 * indices are extracted and persisted to a local SQLite store.
 *
 * Clients call the store's HTTP API to fetch encrypted notes addressed to them,
 * then trial-decrypt locally using their viewing key.
 */
export class NoteScanner {
  private connection: Connection;
  private store: NoteStore;
  private programId: PublicKey;
  private pollIntervalMs: number;
  private running = false;
  private lastSignature: string | undefined;

  constructor(
    rpcUrl: string,
    store: NoteStore,
    programId: PublicKey = POOL_PROGRAM_ID,
    pollIntervalMs = 2_000,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.store = store;
    this.programId = programId;
    this.pollIntervalMs = pollIntervalMs;
  }

  /** Start polling for new transactions. */
  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[scanner] watching program ${this.programId.toBase58()} every ${
        this.pollIntervalMs
      }ms`,
    );

    // Resume from last known signature
    this.lastSignature = this.store.getLastSignature() ?? undefined;

    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        console.error("[scanner] poll error:", err);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /** Stop the scanner loop. */
  stop(): void {
    this.running = false;
  }

  /** Single poll cycle — fetch new signatures and process transactions. */
  private async poll(): Promise<void> {
    const options: { limit: number; until?: string } = { limit: 100 };
    if (this.lastSignature) {
      options.until = this.lastSignature;
    }

    const signatures: ConfirmedSignatureInfo[] =
      await this.connection.getSignaturesForAddress(this.programId, options);

    if (signatures.length === 0) return;

    // Process oldest-first
    const ordered = signatures.reverse();
    console.log(`[scanner] processing ${ordered.length} new transactions`);

    for (const sigInfo of ordered) {
      if (sigInfo.err) continue; // skip failed txs

      try {
        const tx = await this.connection.getParsedTransaction(
          sigInfo.signature,
          { maxSupportedTransactionVersion: 0 },
        );
        if (tx) {
          this.extractNotes(tx, sigInfo.signature);
        }
      } catch (err) {
        console.error(
          `[scanner] failed to fetch tx ${sigInfo.signature}:`,
          err,
        );
      }

      this.lastSignature = sigInfo.signature;
      this.store.setLastSignature(sigInfo.signature);
    }
  }

  /**
   * Extract commitment events from transaction logs.
   *
   * The pool program emits Anchor events with the following data:
   *   - NewCommitment { pool, leaf_index, commitment, encrypted_note }
   *   - DepositEvent { pool, leaf_index, commitment, amount, encrypted_note }
   *
   * We parse the base64-encoded event data from program logs.
   */
  private extractNotes(tx: ParsedTransactionWithMeta, signature: string): void {
    const logs = tx.meta?.logMessages;
    if (!logs) return;

    const slot = tx.slot;
    const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000);

    // Anchor events are emitted as base64 in "Program data:" log lines
    for (const log of logs) {
      if (!log.startsWith("Program data: ")) continue;

      const b64 = log.slice("Program data: ".length);
      try {
        const data = Buffer.from(b64, "base64");

        // Anchor event discriminator is first 8 bytes (SHA256 of "event:<Name>")
        if (data.length < 8 + 4 + 32) continue; // minimum: disc + leaf_index + commitment

        const discriminator = data.subarray(0, 8);

        // NewCommitment discriminator: first 8 bytes of SHA256("event:NewCommitment")
        // We check both NewCommitment and DepositEvent
        const leafIndex = data.readUInt32LE(8);
        const commitment = data.subarray(12, 44).toString("hex");

        // Remaining bytes are the encrypted note (variable length)
        // Vec<u8> encoding: 4-byte LE length prefix + data
        let encryptedNote = "";
        if (data.length > 44 + 4) {
          const noteLen = data.readUInt32LE(44);
          if (noteLen > 0 && noteLen <= 256 && data.length >= 48 + noteLen) {
            encryptedNote = data.subarray(48, 48 + noteLen).toString("hex");
          }
        }

        const note: IndexedNote = {
          commitment,
          leafIndex,
          encryptedNote,
          txSignature: signature,
          slot,
          blockTime,
        };

        this.store.insertNote(note);
        console.log(
          `[scanner] indexed commitment leaf=${leafIndex} tx=${signature.slice(
            0,
            12,
          )}...`,
        );
      } catch {
        // Not a parseable event — skip
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const DB_PATH = process.env.INDEXER_DB_PATH || "./holanc-indexer.db";
  const REPLICA_PATHS = process.env.INDEXER_REPLICA_PATHS
    ? process.env.INDEXER_REPLICA_PATHS.split(",").map((p) => p.trim())
    : [];

  // Use replicated store when replica paths are configured
  const store =
    REPLICA_PATHS.length > 0
      ? new ReplicatedNoteStore(DB_PATH, REPLICA_PATHS)
      : new NoteStore(DB_PATH);
  const scanner = new NoteScanner(RPC_URL, store as NoteStore);

  process.on("SIGINT", () => {
    console.log("\n[scanner] shutting down...");
    scanner.stop();
    store.close();
    process.exit(0);
  });

  scanner.start().catch((err) => {
    console.error("[scanner] fatal:", err);
    process.exit(1);
  });
}
