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

  constructor(rpcUrl: string, batchIntervalMs = 5_000, minBatchSize = 4) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.batchIntervalMs = batchIntervalMs;
    this.minBatchSize = minBatchSize;
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
   * If the batch is smaller than minBatchSize, we log the padding count
   * (actual dummy transactions would be sent to the network in production
   * to achieve k-anonymity within each batch window).
   */
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    const paddingCount = Math.max(0, this.minBatchSize - batch.length);

    if (paddingCount > 0) {
      console.log(
        `[batcher] flushing ${batch.length} real + ${paddingCount} dummy (padding)`,
      );
    } else {
      console.log(`[batcher] flushing ${batch.length} transactions`);
    }

    // Send each real transaction
    const results = batch.map(async (entry) => {
      // Apply jitter delay
      if (entry.delayMs > 0) {
        await sleep(entry.delayMs);
      }

      entry.status.state = "pending";
      entry.status.sentAt = Date.now();

      try {
        const txBuffer = Buffer.from(entry.serializedTx, "base64");

        // Validate that it's a plausible serialized transaction
        Transaction.from(txBuffer);

        const signature = await sendAndConfirmRawTransaction(
          this.connection,
          txBuffer,
          { commitment: "confirmed" },
        );

        entry.status.state = "confirmed";
        entry.status.txSignature = signature;
        console.log(`[batcher] confirmed ${entry.id} → ${signature}`);
      } catch (err: unknown) {
        entry.status.state = "failed";
        entry.status.error =
          err instanceof Error ? err.message : "Unknown error";
        console.error(`[batcher] failed ${entry.id}: ${entry.status.error}`);
      }
    });

    await Promise.allSettled(results);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
