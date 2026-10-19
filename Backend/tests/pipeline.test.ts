import { describe, expect, it } from "vitest";
import { formatSse } from "../lib/sse";
import { truncateText } from "../lib/text";
import { buildContextSnapshot } from "../llm/memory";
import { buildPrompt } from "../llm/buildPrompt";
import { buildQueryOptimizationContext } from "../retrieval/query";
import { dedupeWebSearchResults, type WebSearchResult } from "../retrieval/search";

const result = (url: string, extra: Partial<WebSearchResult> = {}): WebSearchResult => ({
  title: "t",
  url,
  content: "c",
  sourceType: "search",
  ...extra,
});

describe("SSE framing", () => {
  it("emits one data line terminated by a blank line", () => {
    expect(formatSse({ type: "delta", text: "a\nb" })).toBe('data: {"type":"delta","text":"a\\nb"}\n\n');
  });
});

describe("text helpers", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(truncateText("a  b\n c", 10)).toBe("a b c");
    expect(truncateText("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("search results", () => {
  it("dedupes by normalized URL, keeping the first (extracted) copy", () => {
    const deduped = dedupeWebSearchResults([
      result("https://a.com/x#top", { sourceType: "direct_url_extract" }),
      result("https://a.com/x"),
      result("https://b.com"),
    ]);
    expect(deduped.map((r) => r.sourceType)).toEqual(["direct_url_extract", "search"]);
  });
});

describe("prompt building", () => {
  it("fills every placeholder and strips rawContent", () => {
    const results = [result("https://a.com", { rawContent: "SECRET_RAW", images: ["https://a.com/i.png"] })];
    const prompt = buildPrompt(
      buildQueryOptimizationContext("what is new"),
      [{ url: "https://a.com", title: "A", text: "passage one" }],
      results,
    );
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(prompt).not.toContain("SECRET_RAW");
    expect(prompt).toContain("https://a.com/i.png");
    expect(prompt).toContain("what is new");
    expect(prompt).toContain("[1] A (https://a.com)\npassage one");
  });
});

describe("memory snapshot", () => {
  it("lists every user query and caps recent messages at 10", () => {
    const history = Array.from({ length: 14 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `m${i}`,
    }));
    const snapshot = buildContextSnapshot(history);
    expect(snapshot).toContain("7. m12");
    expect(snapshot).toContain("Recent Conversation (10 messages)");
    expect(snapshot).not.toContain("[USER]: m2\n");
  });
});
