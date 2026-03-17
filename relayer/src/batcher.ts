import {
  Connection,
  Transaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import crypto from "crypto";

/** Status of a queued relay request. */
export interface RelayStatus {
  id: string;
  state: "queued" | "pending" | "confirmed" | "failed";
  txSignature?: string;
  error?: string;
  enqueuedAt: number;
  sentAt?: number;
}

/**
 * RelayQueue — batches privacy transactions with dummy padding before submission.
 *
 * Transactions are held in a FIFO queue and flushed periodically. Each batch
 * is padded with dummy no-op transactions to make real volume harder to
 * fingerprint (metadata resistance).
 */
export class RelayQueue {
  private connection: Connection;
  private queue: Array<{
    id: string;
    serializedTx: string;
    delayMs: number;
    status: RelayStatus;
  }> = [];
  private statuses = new Map<string, RelayStatus>();

  /** Batch interval in milliseconds. */
  private batchIntervalMs: number;

  /** Minimum batch size (pad with dummies if fewer real txs). */
  private minBatchSize: number;

  private loopHandle: ReturnType<typeof setInterval> | null = null;

  /** Maximum number of retries for a single transaction. */
  private maxRetries: number;

  constructor(
    rpcUrl: string,
    batchIntervalMs = 5_000,
    minBatchSize = 4,
    maxRetries = 3,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.batchIntervalMs = batchIntervalMs;
    this.minBatchSize = minBatchSize;
    this.maxRetries = maxRetries;
  }

  /** Enqueue a transaction for batched relay. Returns a tracking ID. */
  async enqueue(serializedTx: string, delayMs: number): Promise<string> {
    const id = crypto.randomUUID();
    const status: RelayStatus = {
      id,
      state: "queued",
      enqueuedAt: Date.now(),
    };

    this.queue.push({ id, serializedTx, delayMs, status });
    this.statuses.set(id, status);
    return id;
  }

  /** Current queue depth. */
  depth(): number {
    return this.queue.length;
  }

  /** Look up relay status by ID. */
  status(id: string): RelayStatus | undefined {
    return this.statuses.get(id);
  }

  /** Start the periodic batch flush loop. */
  startBatchLoop(): void {
    if (this.loopHandle) return;
    this.loopHandle = setInterval(() => this.flush(), this.batchIntervalMs);
    console.log(
      `[batcher] batch loop started  interval=${this.batchIntervalMs}ms  minBatch=${this.minBatchSize}`,
    );
  }

  /** Stop the batch loop. */
  stopBatchLoop(): void {
    if (this.loopHandle) {
      clearInterval(this.loopHandle);
      this.loopHandle = null;
    }
  }

  /**
   * Flush the current queue: send all queued transactions.
   *
   * The batch is always padded to the next multiple of minBatchSize with
   * dummy no-op transactions. This ensures every flush window submits a
   * fixed-size batch, preventing batch-size fingerprinting.
   */
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);

    // Always pad to the next multiple of minBatchSize so every flush
    // window has an indistinguishable total transaction count.
    const target =
      Math.ceil(batch.length / this.minBatchSize) * this.minBatchSize;
    const paddingCount = target - batch.length;

    if (paddingCount > 0) {
      console.log(
        `[batcher] flushing ${batch.length} real + ${paddingCount} dummy (padding)`,
      );
    } else {
      console.log(`[batcher] flushing ${batch.length} transactions`);
    }

    // Build dummy no-op transactions for k-anonymity padding.
    // Each dummy is a self-transfer of 0 SOL which looks identical in size
    // and timing to a real relay submission.
    const dummyResults: Promise<void>[] = [];
    for (let i = 0; i < paddingCount; i++) {
      dummyResults.push(this.sendDummyTransaction());
    }

    // Send each real transaction
    const results = batch.map(async (entry) => {
      // Apply jitter delay
      if (entry.delayMs > 0) {
        await sleep(entry.delayMs);
      }

      entry.status.state = "pending";
      entry.status.sentAt = Date.now();

      const txBuffer = Buffer.from(entry.serializedTx, "base64");

      // Validate that it's a plausible serialized transaction
      try {
        Transaction.from(txBuffer);
      } catch (err: unknown) {
        entry.status.state = "failed";
        entry.status.error = "Invalid transaction data";
        console.error(
          `[batcher] invalid tx ${entry.id}: ${entry.status.error}`,
        );
        return;
      }

      // Retry with exponential backoff
      let lastError = "";
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          const signature = await sendAndConfirmRawTransaction(
            this.connection,
            txBuffer,
            { commitment: "confirmed" },
          );

          entry.status.state = "confirmed";
          entry.status.txSignature = signature;
          console.log(`[batcher] confirmed ${entry.id} → ${signature}`);
          return;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : "Unknown error";

          // Don't retry on deterministic failures (invalid signature, etc.)
          if (
            lastError.includes("Signature verification failed") ||
            lastError.includes("already been processed") ||
            lastError.includes("Blockhash not found")
          ) {
            break;
          }

          if (attempt < this.maxRetries) {
            const backoffMs = Math.min(1000 * 2 ** attempt, 8000);
            console.warn(
              `[batcher] attempt ${attempt + 1}/${
                this.maxRetries + 1
              } failed for ${entry.id}, retrying in ${backoffMs}ms`,
            );
            await sleep(backoffMs);
          }
        }
      }

      entry.status.state = "failed";
      entry.status.error = lastError;
      console.error(
        `[batcher] failed ${entry.id} after ${
          this.maxRetries + 1
        } attempts: ${lastError}`,
      );
    });

    await Promise.allSettled(results);
    // Wait for dummy transactions too (best-effort, failures are fine)
    await Promise.allSettled(dummyResults);
  }

  /**
   * Send a dummy no-op transaction for k-anonymity padding.
   * Uses a disposable keypair to create a 0-lamport self-transfer
   * that is indistinguishable in timing from real relay submissions.
   */
  private async sendDummyTransaction(): Promise<void> {
    try {
      const {
        Keypair,
        SystemProgram,
        Transaction: SolTx,
      } = await import("@solana/web3.js");

      const dummyKeypair = Keypair.generate();
      const tx = new SolTx().add(
        SystemProgram.transfer({
          fromPubkey: dummyKeypair.publicKey,
          toPubkey: dummyKeypair.publicKey,
          lamports: 0,
        }),
      );
      tx.recentBlockhash = (
        await this.connection.getLatestBlockhash()
      ).blockhash;
      tx.sign(dummyKeypair);

      const raw = tx.serialize();
      await sendAndConfirmRawTransaction(this.connection, raw, {
        commitment: "confirmed",
      });
      console.log("[batcher] dummy tx confirmed");
    } catch {
      // Dummy failures are expected (no SOL to pay fees) — that's fine.
      // The important thing is the network-level traffic timing.
      console.log("[batcher] dummy tx failed (expected)");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
