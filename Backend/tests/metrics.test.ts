import { describe, expect, it } from "vitest";
import {
  citationValidity,
  cohenKappa,
  extractCitedUrls,
  parseAnswerSections,
  percentile,
} from "../evals/metrics";

describe("parseAnswerSections", () => {
  it("strips think, extracts answer and follow-ups", () => {
    const raw = `<think>x</think><ANSWER>Hello [a](https://a.com/x)</ANSWER>
<FOLLOW_UPS><question>q1</question><question>q2</question><question>q3</question></FOLLOW_UPS>`;
    const parsed = parseAnswerSections(raw);
    expect(parsed.answer).toBe("Hello [a](https://a.com/x)");
    expect(parsed.followUps).toEqual(["q1", "q2", "q3"]);
    expect(parsed.formatOk).toBe(true);
  });

  it("flags a missing contract but still returns the text", () => {
    const parsed = parseAnswerSections("plain answer");
    expect(parsed.formatOk).toBe(false);
    expect(parsed.answer).toBe("plain answer");
  });
});

describe("citations", () => {
  it("extracts markdown and bare URLs without trailing brackets", () => {
    expect(extractCitedUrls("see [x](https://a.com/p) and https://b.com/q.")).toEqual([
      "https://a.com/p",
      "https://b.com/q",
    ]);
  });

  it("scores the share of cited URLs that were retrieved", () => {
    expect(citationValidity(["https://a.com/p", "https://made.up/"], ["https://a.com/p#top"])).toBe(0.5);
    expect(citationValidity([], ["https://a.com"])).toBeNull();
  });
});

describe("stats", () => {
  it("nearest-rank percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("Cohen's kappa: perfect, chance, and a textbook case", () => {
    expect(cohenKappa([true, false, true], [true, false, true])).toBe(1);
    expect(cohenKappa([true, true, false, false], [true, false, true, false])).toBe(0);
    // 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no -> kappa = 0.4
    const a = [...Array(25).fill(true), ...Array(25).fill(false)];
    const b = [...Array(20).fill(true), ...Array(5).fill(false), ...Array(10).fill(true), ...Array(15).fill(false)];
    expect(cohenKappa(a, b)).toBeCloseTo(0.4, 10);
  });
});
