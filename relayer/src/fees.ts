import { Connection } from "@solana/web3.js";

export interface FeeEstimate {
  /** Base relay fee in lamports. */
  baseFee: number;
  /** Priority fee (based on recent network conditions) in lamports. */
  priorityFee: number;
  /** Total estimated fee in lamports. */
  totalFee: number;
  /** Timestamp of this estimate. */
  timestamp: number;
}

/**
 * FeeEstimator — estimates relay fees based on current network conditions.
 *
 * The relayer charges a base fee to cover:
 *   1. Solana transaction fee (~5000 lamports)
 *   2. Compute unit cost for Groth16 verification (~300-400K CU)
 *   3. Relayer operational margin
 *
 * Plus a dynamic priority fee based on recent slot leader tips.
 */
export class FeeEstimator {
  private connection: Connection;

  /** Base fee covering tx cost + compute + margin (in lamports). */
  private baseFee: number;

  /** Cache duration for priority fee lookups. */
  private cacheDurationMs = 30_000;
  /** Timeout for individual RPC calls (ms). */
  private rpcTimeoutMs = 1_000;
  private cachedPriorityFee: number | null = null;
  private cacheTimestamp = 0;

  constructor(rpcUrl: string, baseFee = 50_000) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.baseFee = baseFee;
  }

  /** Estimate the total relay fee. */
  async estimate(): Promise<FeeEstimate> {
    const priorityFee = await this.getPriorityFee();
    return {
      baseFee: this.baseFee,
      priorityFee,
      totalFee: this.baseFee + priorityFee,
      timestamp: Date.now(),
    };
  }

  /**
   * Fetch recent priority fee from the network.
   * Cached for cacheDurationMs to avoid excessive RPC calls.
   */
  private async getPriorityFee(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedPriorityFee !== null &&
      now - this.cacheTimestamp < this.cacheDurationMs
    ) {
      return this.cachedPriorityFee;
    }

    try {
      const fees = await raceTimeout(
        this.connection.getRecentPrioritizationFees(),
        this.rpcTimeoutMs,
      );
      if (fees.length === 0) {
        this.cachedPriorityFee = 0;
      } else {
        // Use median priority fee from recent slots
        const sorted = fees
          .map((f) => f.prioritizationFee)
          .sort((a, b) => a - b);
        this.cachedPriorityFee = sorted[Math.floor(sorted.length / 2)];
      }
    } catch {
      // Default to 0 if RPC fails or times out
      this.cachedPriorityFee = 0;
    }

    this.cacheTimestamp = now;
    return this.cachedPriorityFee;
  }
}

/** Race a promise against a timeout; rejects with an error on expiry. */
function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
