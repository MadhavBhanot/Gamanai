import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ tavly: {} }));
import { isLowRelevance } from "../retrieval/search";

describe("isLowRelevance", () => {
  it("flags a result set whose best score is junk-level", () => {
    expect(isLowRelevance([{ score: 0.062 }, { score: 0.05 }])).toBe(true); // the Korean-won case
    expect(isLowRelevance([{ score: 0.05 }, { score: 0.72 }])).toBe(false);
  });

  it("treats an empty set as fine and unscored results as low", () => {
    expect(isLowRelevance([])).toBe(false);
    expect(isLowRelevance([{}])).toBe(true);
  });
});
