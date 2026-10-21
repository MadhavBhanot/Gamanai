import { afterEach, describe, expect, it, vi } from "vitest";
import { rerankDocuments } from "../retrieval/rerank";

describe("rerankDocuments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns document indices best first, cut to topN", async () => {
    vi.stubEnv("JINA_API_KEY", "test");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 2, relevance_score: 0.9 }, { index: 1, relevance_score: 0.5 }] })),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await rerankDocuments("q", ["a", "b", "c"], 2)).toEqual([2, 1]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ query: "q", documents: ["a", "b", "c"], top_n: 2 });
  });

  it("throws without a key or on an API error, so retrieval falls back", async () => {
    vi.stubEnv("JINA_API_KEY", "");
    await expect(rerankDocuments("q", ["a"], 1)).rejects.toThrow("JINA_API_KEY");

    vi.stubEnv("JINA_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(rerankDocuments("q", ["a"], 1)).rejects.toThrow("Jina rerank 429");
  });
});
