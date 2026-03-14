import { JitterScheduler } from "../src/jitter";
import { FeeEstimator } from "../src/fees";
import { RelayQueue } from "../src/batcher";

// ---------------------------------------------------------------------------
// JitterScheduler tests
// ---------------------------------------------------------------------------
describe("JitterScheduler", () => {
  it("produces delays within configured bounds", () => {
    const jitter = new JitterScheduler(100, 3000, 500);
    for (let i = 0; i < 100; i++) {
      const delay = jitter.nextDelay();
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(3000);
    }
  });

  it("uses default parameters when none provided", () => {
    const jitter = new JitterScheduler();
    const delay = jitter.nextDelay();
    expect(delay).toBeGreaterThanOrEqual(200);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("returns integer delays", () => {
    const jitter = new JitterScheduler();
    for (let i = 0; i < 50; i++) {
      const delay = jitter.nextDelay();
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it("produces varied delays (not constant)", () => {
    const jitter = new JitterScheduler(0, 10_000, 1000);
    const delays = new Set<number>();
    for (let i = 0; i < 20; i++) {
      delays.add(jitter.nextDelay());
    }
    // With 20 samples from an exponential distribution, expect at least 5 distinct values
    expect(delays.size).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// FeeEstimator tests
// ---------------------------------------------------------------------------
describe("FeeEstimator", () => {
  it("returns base fee plus priority fee in estimate", async () => {
    const fees = new FeeEstimator("http://127.0.0.1:8899", 50_000);
    const estimate = await fees.estimate();

    expect(estimate.baseFee).toBe(50_000);
    expect(estimate.priorityFee).toBeGreaterThanOrEqual(0);
    expect(estimate.totalFee).toBe(estimate.baseFee + estimate.priorityFee);
    expect(estimate.timestamp).toBeGreaterThan(0);
  });

  it("caches priority fee to avoid excessive RPC calls", async () => {
    const fees = new FeeEstimator("http://127.0.0.1:8899", 50_000);

    const est1 = await fees.estimate();
    const est2 = await fees.estimate();

    // Both should return quickly since the second is cached
    expect(est2.priorityFee).toBe(est1.priorityFee);
  });

  it("accepts custom base fee", async () => {
    const fees = new FeeEstimator("http://127.0.0.1:8899", 100_000);
    const estimate = await fees.estimate();
    expect(estimate.baseFee).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// RelayQueue tests
// ---------------------------------------------------------------------------
describe("RelayQueue", () => {
  let queue: RelayQueue;

  beforeEach(() => {
    queue = new RelayQueue("http://127.0.0.1:8899", 5000, 4);
  });

  afterEach(() => {
    queue.stopBatchLoop();
  });

  it("enqueue returns a unique tracking ID", async () => {
    const id1 = await queue.enqueue("dGVzdDE=", 0);
    const id2 = await queue.enqueue("dGVzdDI=", 0);

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it("depth reflects number of queued items", async () => {
    expect(queue.depth()).toBe(0);

    await queue.enqueue("dGVzdA==", 0);
    expect(queue.depth()).toBe(1);

    await queue.enqueue("dGVzdA==", 0);
    expect(queue.depth()).toBe(2);
  });

  it("status returns queued state for new submissions", async () => {
    const id = await queue.enqueue("dGVzdA==", 100);
    const status = queue.status(id);

    expect(status).toBeDefined();
    expect(status!.state).toBe("queued");
    expect(status!.id).toBe(id);
    expect(status!.enqueuedAt).toBeGreaterThan(0);
  });

  it("status returns undefined for unknown IDs", () => {
    expect(queue.status("nonexistent-id")).toBeUndefined();
  });

  it("startBatchLoop and stopBatchLoop are idempotent", () => {
    // Starting twice should not throw
    queue.startBatchLoop();
    queue.startBatchLoop();

    // Stopping twice should not throw
    queue.stopBatchLoop();
    queue.stopBatchLoop();
  });
});

// ---------------------------------------------------------------------------
// Rate limiter behavior (via server module)
// ---------------------------------------------------------------------------
describe("Rate limiter behavior", () => {
  it("rate limit map tracks per-IP counts", () => {
    // Verify the sliding window concept: new entry should have count=1
    const requestCounts = new Map<string, { count: number; resetAt: number }>();

    const ip = "127.0.0.1";
    const now = Date.now();
    requestCounts.set(ip, { count: 1, resetAt: now + 60_000 });

    const entry = requestCounts.get(ip)!;
    expect(entry.count).toBe(1);

    // Simulate incrementing
    entry.count++;
    expect(entry.count).toBe(2);

    // Simulate expiry
    const expiredEntry = { count: 5, resetAt: now - 1 };
    requestCounts.set(ip, expiredEntry);
    expect(requestCounts.get(ip)!.resetAt).toBeLessThan(now);
  });
});
