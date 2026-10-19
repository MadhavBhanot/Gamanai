import { describe, expect, it } from "vitest";
import { parseRetryDelayMs, TokenPacer } from "../evals/pacer";

function fakeClock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe("TokenPacer", () => {
  it("lets calls through while budget remains, then waits for refill", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(6000, clock.now, clock.sleep);

    await pacer.take(4000);
    await pacer.take(2000);
    expect(clock.waits).toEqual([]);

    await pacer.take(3000); // empty bucket: 3000 tokens at 100/s -> 30s
    expect(clock.waits).toEqual([30_000]);
  });

  it("caps an oversize request at one minute of budget instead of deadlocking", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(1000, clock.now, clock.sleep);
    await pacer.take(5000);
    await pacer.take(1000);
    expect(clock.waits).toEqual([60_000]);
  });

  it("serves concurrent callers in order without overspending", async () => {
    const clock = fakeClock();
    const pacer = new TokenPacer(1000, clock.now, clock.sleep);
    await Promise.all([pacer.take(600), pacer.take(600), pacer.take(600)]);
    // 600 free, then two waits of 12s (200 short) and 36s (600 short)
    expect(clock.waits).toEqual([12_000, 36_000]);
  });
});

describe("parseRetryDelayMs", () => {
  it("parses Groq's human-readable waits", () => {
    expect(parseRetryDelayMs("Please try again in 19m16.464s. Need more")).toBeCloseTo(1_156_464, 0);
    expect(parseRetryDelayMs("try again in 1h2m3s")).toBe(3_723_000);
    expect(parseRetryDelayMs("try again in 577ms")).toBe(577);
    expect(parseRetryDelayMs("try again in 7.5s")).toBe(7_500);
    expect(parseRetryDelayMs('{"@type":"RetryInfo","retryDelay": "17s"}')).toBe(17_000);
    expect(parseRetryDelayMs("no hint here")).toBeNull();
  });
});
