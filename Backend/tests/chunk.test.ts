import { describe, expect, it } from "vitest";
import { chunkText, cleanPageText } from "../retrieval/chunk";

describe("cleanPageText", () => {
  it("drops images and keeps link text", () => {
    expect(cleanPageText("See ![logo](a.png) the [docs](https://x.dev) now")).toBe("See the docs now");
  });
});

describe("chunkText", () => {
  const para = (n: number) => `Sentence number ${n} talks about retrieval quality. `.repeat(6).trim();
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");

  it("keeps chunks near the target size and covers the whole text", () => {
    const chunks = chunkText(text, 500, 80);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks[chunks.length - 1]).toContain("Sentence number 11");
  });

  it("snaps to sentence or paragraph boundaries", () => {
    for (const c of chunkText(text, 500, 80).slice(0, -1)) expect(c).toMatch(/\.$/);
  });

  it("overlaps consecutive chunks", () => {
    const [a, b] = chunkText(text, 500, 80);
    expect(a.slice(-40)).not.toBe("");
    expect(b.startsWith(a.slice(-20).trim())).toBe(false); // starts earlier than the tail...
    expect(a.includes(b.slice(0, 30))).toBe(true); // ...because b's opening lies inside a
  });

  it("handles text without any boundaries and short input", () => {
    expect(chunkText("x".repeat(1200), 500, 50).length).toBe(3);
    expect(chunkText("tiny")).toEqual([]);
  });
});

describe("chunk starts", () => {
  it("never opens a chunk mid-word", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    for (const c of chunkText(words, 300, 60)) expect(c).toMatch(/^word\d+/);
  });
});
