/**
 * Multi-RPC failover for Solana connections.
 *
 * Provides automatic failover across multiple RPC endpoints with circuit
 * breaker logic to avoid hammering down endpoints.
 *
 * Usage:
 *   const conn = new FailoverConnection(["https://rpc1.example.com", "https://rpc2.example.com"]);
 *   const balance = await conn.exec(c => c.getBalance(pubkey));
 */

import { Connection, Commitment } from "@solana/web3.js";

export interface RpcEndpointConfig {
  /** RPC endpoint URL */
  url: string;
  /** Weight for selection (higher = preferred). Default: 1 */
  weight?: number;
}

export interface FailoverConfig {
  /** Commitment level for all connections. Default: "confirmed" */
  commitment?: Commitment;
  /** Max consecutive failures before circuit opens. Default: 3 */
  maxFailures?: number;
  /** Cool-down (ms) before retrying a tripped endpoint. Default: 30_000 */
  cooldownMs?: number;
  /** Per-attempt timeout (ms). 0 = no timeout. Default: 0 */
  timeoutMs?: number;
}

interface EndpointState {
  url: string;
  weight: number;
  connection: Connection;
  failures: number;
  openUntil: number; // epoch ms when circuit can be retried
}

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class FailoverConnection {
  private endpoints: EndpointState[];
  private maxFailures: number;
  private cooldownMs: number;
  private timeoutMs: number;

  constructor(
    endpoints: (string | RpcEndpointConfig)[],
    config: FailoverConfig = {},
  ) {
    if (endpoints.length === 0) {
      throw new Error("At least one RPC endpoint is required");
    }

    const commitment = config.commitment ?? "confirmed";
    this.maxFailures = config.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.timeoutMs = config.timeoutMs ?? 0;

    this.endpoints = endpoints.map((ep) => {
      const url = typeof ep === "string" ? ep : ep.url;
      const weight = typeof ep === "string" ? 1 : ep.weight ?? 1;
      return {
        url,
        weight,
        connection: new Connection(url, commitment),
        failures: 0,
        openUntil: 0,
      };
    });
  }

  /**
   * Execute an RPC call with automatic failover.
   *
   * Tries each healthy endpoint in weight-priority order. If all endpoints
   * are tripped, tries the one whose cool-down expires soonest.
   */
  async exec<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const now = Date.now();

    // Sort endpoints: healthy first (sorted by weight desc), then tripped (sorted by openUntil asc)
    const healthy = this.endpoints
      .filter((e) => e.failures < this.maxFailures || e.openUntil <= now)
      .sort((a, b) => b.weight - a.weight);

    const candidates =
      healthy.length > 0
        ? healthy
        : // All tripped — try the one that cools down soonest
          [...this.endpoints].sort((a, b) => a.openUntil - b.openUntil);

    let lastError: Error | undefined;
    for (const ep of candidates) {
      try {
        const result = this.timeoutMs > 0
          ? await withTimeout(fn(ep.connection), this.timeoutMs)
          : await fn(ep.connection);
        // Success: reset failures
        ep.failures = 0;
        ep.openUntil = 0;
        return result;
      } catch (err: any) {
        ep.failures++;
        if (ep.failures >= this.maxFailures) {
          ep.openUntil = Date.now() + this.cooldownMs;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw new Error(
      `All ${this.endpoints.length} RPC endpoints failed. Last error: ${lastError?.message}`,
    );
  }

  /** Get the currently preferred (first healthy) Connection for direct use. */
  get primary(): Connection {
    const now = Date.now();
    const healthy = this.endpoints.find(
      (e) => e.failures < this.maxFailures || e.openUntil <= now,
    );
    return (healthy ?? this.endpoints[0]).connection;
  }

  /** Reset all circuit breakers. */
  reset(): void {
    for (const ep of this.endpoints) {
      ep.failures = 0;
      ep.openUntil = 0;
    }
  }

  /** Get health status of all endpoints. */
  status(): Array<{
    url: string;
    healthy: boolean;
    failures: number;
    openUntil: number;
  }> {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      url: e.url,
      healthy: e.failures < this.maxFailures || e.openUntil <= now,
      failures: e.failures,
      openUntil: e.openUntil,
    }));
  }
}

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
