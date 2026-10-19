import { describe, expect, it } from "vitest";
import {
  buildQueryOptimizationContext,
  extractDomainsFromUrls,
  extractUrlsFromQuery,
  isFocusedDomainMatch,
  normalizeUrl,
} from "../retrieval/query";

describe("URL-aware query optimization", () => {
  it("extracts URLs, trims trailing punctuation and hashes, dedupes", () => {
    const urls = extractUrlsFromQuery(
      "compare https://github.com/MadhavBhanot, and https://github.com/MadhavBhanot#readme!",
    );
    expect(urls).toEqual(["https://github.com/MadhavBhanot"]);
  });

  it("rejects non-http schemes", () => {
    expect(normalizeUrl("ftp://example.com")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("derives bare domains (regression: domains were filtered out by the http-only dedupe)", () => {
    expect(
      extractDomainsFromUrls(["https://www.GitHub.com/a", "https://github.com/b", "https://docs.rs/x"]),
    ).toEqual(["github.com", "docs.rs"]);
  });

  it("builds a site:-focused search query", () => {
    const ctx = buildQueryOptimizationContext("summarize https://react.dev/learn please");
    expect(ctx.queryWithoutUrls).toBe("summarize please");
    expect(ctx.referencedDomains).toEqual(["react.dev"]);
    expect(ctx.optimizedSearchQuery).toBe('summarize please "https://react.dev/learn" site:react.dev');
  });

  it("falls back to the raw query when there is no URL", () => {
    const ctx = buildQueryOptimizationContext("latest groq models");
    expect(ctx.optimizedSearchQuery).toBe("latest groq models");
    expect(ctx.llmFocusBlock).toMatch(/No explicit URL/);
  });

  it("matches focused domains ignoring www", () => {
    expect(isFocusedDomainMatch("https://www.react.dev/x", ["react.dev"])).toBe(true);
    expect(isFocusedDomainMatch("https://vuejs.org", ["react.dev"])).toBe(false);
    expect(isFocusedDomainMatch("garbage", ["react.dev"])).toBe(false);
  });
});
