import crypto from "crypto";

/**
 * JitterScheduler — adds randomized timing delays to transaction relay
 * for metadata resistance.
 *
 * Each transaction receives an independent random delay sampled from a
 * truncated exponential distribution. This prevents timing correlation
 * between user actions and on-chain submissions.
 *
 * Parameters:
 *   - baseDelayMs:  minimum delay (floor)
 *   - maxDelayMs:   maximum delay (cap)
 *   - meanDelayMs:  mean of the exponential distribution
 */
export class JitterScheduler {
  private baseDelayMs: number;
  private maxDelayMs: number;
  private meanDelayMs: number;

  constructor(baseDelayMs = 200, maxDelayMs = 5_000, meanDelayMs = 1_000) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.meanDelayMs = meanDelayMs;
  }

  /**
   * Sample the next jitter delay in milliseconds.
   *
   * Uses a truncated exponential distribution to produce delays that are
   * usually short but occasionally longer, matching natural network jitter
   * patterns while providing timing decorrelation.
   */
  nextDelay(): number {
    // Exponential variate: -mean * ln(U) where U ~ Uniform(0,1)
    const u = crypto.randomBytes(4).readUInt32BE() / 0xffffffff;
    // Clamp u away from 0 to avoid -ln(0) = Infinity
    const uClamped = Math.max(u, 1e-10);
    const raw = -this.meanDelayMs * Math.log(uClamped);
    const clamped = Math.min(raw, this.maxDelayMs - this.baseDelayMs);
    return Math.round(this.baseDelayMs + clamped);
  }
}
