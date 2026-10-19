/**
 * Client-side tokens-per-minute budget (token bucket). Waiting here before each call keeps
 * us under the provider's TPM limit instead of burning requests on 429 + retry-after loops.
 */
export class TokenPacer {
  private available: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.available = perMinute;
    this.last = now();
  }

  /** Resolves once `tokens` fit in the budget; callers are served in order. */
  take(tokens: number): Promise<void> {
    const needed = Math.min(tokens, this.perMinute); // a single oversize call must still be able to go
    this.queue = this.queue.then(async () => {
      this.refill();
      while (this.available < needed) {
        await this.sleep(Math.ceil(((needed - this.available) / this.perMinute) * 60_000));
        this.refill();
      }
      this.available -= needed;
    });
    return this.queue;
  }

  private refill() {
    const t = this.now();
    this.available = Math.min(this.perMinute, this.available + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
  }
}

/** Rough token estimate (~3.5 chars/token for English + JSON); deliberately conservative. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
