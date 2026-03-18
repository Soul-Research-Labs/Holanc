import express, { Request, Response, NextFunction } from "express";
import { RelayQueue } from "./batcher";
import { JitterScheduler } from "./jitter";
import { FeeEstimator } from "./fees";
import { EvmRelayer } from "./evm-relayer";

const PORT = parseInt(process.env.RELAYER_PORT || "3001", 10);
const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const ETH_RPC_URL = process.env.ETH_RPC_URL || "";
const ETH_RELAYER_KEY = process.env.ETH_RELAYER_PRIVATE_KEY || "";

const app = express();
app.use(express.json({ limit: "64kb" }));

// ---------------------------------------------------------------------------
// Per-IP rate limiter (sliding window, configurable)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now >= entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  entry.count++;
  next();
}

app.use(rateLimiter);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const relayQueue = new RelayQueue(RPC_URL);
const jitter = new JitterScheduler();
const fees = new FeeEstimator(RPC_URL);

// Initialize EVM relayer if configured
const evmRelayer =
  ETH_RPC_URL && ETH_RELAYER_KEY
    ? new EvmRelayer(ETH_RPC_URL, ETH_RELAYER_KEY)
    : null;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health check. */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", queueDepth: relayQueue.depth() });
});

/**
 * POST /relay
 *
 * Submit a signed privacy transaction for batched relay.
 *
 * Body:
 *   serializedTx    — base64-encoded signed Solana transaction
 *   proofEnvelope   — hex-encoded 2048-byte proof envelope (optional, for validation)
 */
app.post("/relay", async (req: Request, res: Response) => {
  const { serializedTx } = req.body;

  if (
    !serializedTx ||
    typeof serializedTx !== "string" ||
    serializedTx.length > 4096
  ) {
    res.status(400).json({ error: "Invalid or missing serializedTx" });
    return;
  }

  try {
    const id = await relayQueue.enqueue(serializedTx, jitter.nextDelay());
    res.json({ id, status: "queued" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/** GET /relay/:id — Check relay status. */
app.get("/relay/:id", (req: Request, res: Response) => {
  const status = relayQueue.status(req.params.id);
  if (!status) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(status);
});

/** GET /fee — Estimate relay fee for current network conditions. */
app.get("/fee", async (_req: Request, res: Response) => {
  try {
    const estimate = await fees.estimate();
    res.json(estimate);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// EVM relay endpoints
// ---------------------------------------------------------------------------

/**
 * POST /relay/evm
 *
 * Submit a signed EVM transaction for relaying to an Ethereum-compatible chain.
 *
 * Body:
 *   signedTx   — hex-encoded signed EVM transaction (0x-prefixed)
 *   chain      — optional chain identifier (default: "ethereum")
 */
app.post("/relay/evm", async (req: Request, res: Response) => {
  if (!evmRelayer) {
    res
      .status(503)
      .json({
        error:
          "EVM relay not configured (set ETH_RPC_URL and ETH_RELAYER_PRIVATE_KEY)",
      });
    return;
  }

  const { signedTx } = req.body;

  if (
    !signedTx ||
    typeof signedTx !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(signedTx) ||
    signedTx.length > 8192
  ) {
    res
      .status(400)
      .json({ error: "Invalid or missing signedTx (must be 0x-prefixed hex)" });
    return;
  }

  try {
    const delayMs = jitter.nextDelay();
    const id = await evmRelayer.enqueue(signedTx, delayMs);
    res.json({ id, status: "queued" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

/** GET /relay/evm/:id — Check EVM relay status. */
app.get("/relay/evm/:id", (req: Request, res: Response) => {
  if (!evmRelayer) {
    res.status(503).json({ error: "EVM relay not configured" });
    return;
  }
  const status = evmRelayer.status(req.params.id);
  if (!status) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(status);
});

/** GET /fee/evm — Estimate EVM relay fee (gas price). */
app.get("/fee/evm", async (_req: Request, res: Response) => {
  if (!evmRelayer) {
    res.status(503).json({ error: "EVM relay not configured" });
    return;
  }
  try {
    const estimate = await evmRelayer.estimateFee();
    res.json(estimate);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[holanc-relayer] listening on :${PORT}  rpc=${RPC_URL}`);
  relayQueue.startBatchLoop();
});

export { app };
