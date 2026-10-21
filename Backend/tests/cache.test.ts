import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), embedTexts: vi.fn() }));
vi.mock("../db", () => ({ prisma: { $queryRaw: mocks.queryRaw, $executeRaw: vi.fn() } }));
vi.mock("../retrieval/embed", () => ({
  EMBEDDING_MODEL: "test-model",
  embedTexts: mocks.embedTexts,
  toVectorLiteral: (e: number[]) => `[${e.join(",")}]`,
}));
import { isCacheable, lookupCachedAnswer } from "../llm/cache";

describe("isCacheable", () => {
  it("skips time-sensitive questions and URL questions", () => {
    expect(isCacheable("How does HNSW indexing work in pgvector?")).toBe(true);
    expect(isCacheable("What is the latest Postgres release?")).toBe(false);
    expect(isCacheable("bitcoin price today")).toBe(false);
    expect(isCacheable("Summarize https://example.com/post")).toBe(false);
  });
});

describe("lookupCachedAnswer", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
    mocks.embedTexts.mockReset().mockResolvedValue([[0.1, 0.2]]);
  });

  it("hits only at or above the similarity threshold", async () => {
    mocks.queryRaw.mockResolvedValueOnce([{ content: "a", sources: [], similarity: 0.97 }]);
    expect((await lookupCachedAnswer("what is rrf", "quick")).hit?.content).toBe("a");

    mocks.queryRaw.mockResolvedValueOnce([{ content: "b", sources: [], similarity: 0.9 }]);
    const miss = await lookupCachedAnswer("what is rrf", "quick");
    expect(miss.hit).toBeNull();
    expect(miss.embedding).toEqual([0.1, 0.2]); // reused to store the new answer
  });

  it("never throws and skips embedding for uncacheable questions", async () => {
    mocks.embedTexts.mockRejectedValueOnce(new Error("429"));
    expect(await lookupCachedAnswer("what is rrf", "quick")).toEqual({ hit: null, embedding: null });

    await lookupCachedAnswer("latest news", "quick");
    expect(mocks.embedTexts).toHaveBeenCalledTimes(1);
  });
});
