import { describe, expect, it } from "vitest";
import { fuseRankings, toOrQuery } from "../retrieval/hybrid";

describe("fuseRankings (RRF)", () => {
  it("rewards items ranked well by both lists", () => {
    const s = fuseRankings([
      { order: ["a", "b", "c"], weight: 1 },
      { order: ["b", "a", "d"], weight: 1 },
    ], 60);
    expect(s.get("a")).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(s.get("b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(s.get("c")! < s.get("a")!).toBe(true);
    expect(s.get("d")).toBeCloseTo(1 / 63, 12);
  });

  it("a zero weight removes a ranking's influence", () => {
    const s = fuseRankings([{ order: ["x", "y"], weight: 1 }, { order: ["y", "x"], weight: 0 }]);
    expect(s.get("x")! > s.get("y")!).toBe(true);
  });
});

describe("toOrQuery", () => {
  it("ORs content words and drops stopwords and URLs", () => {
    expect(toOrQuery("What are the free parameters of https://x.dev BM25?")).toBe("free or parameters or bm25");
  });
});
