import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.EMBEDDING_MODEL = "nvidia:test"; // 0.6 top / 0.55 support defaults
  return { queryRaw: vi.fn(), embedTexts: vi.fn() };
});
vi.mock("../db", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock("../retrieval/embed", () => ({
  EMBEDDING_MODEL: "nvidia:test",
  embedTexts: mocks.embedTexts,
  toVectorLiteral: (e: number[]) => `[${e.join(",")}]`,
}));
vi.mock("../retrieval/images", () => ({ liveImageUrls: async () => [] }));
import { answerFromIndex } from "../llm/answer";
import { isIndexConfident } from "../retrieval/indexFirst";

const chunk = (similarity: number, url = "https://a.com") => ({ url, title: "t", content: "pgvector HNSW passage", similarity });

describe("isIndexConfident", () => {
  it("needs a strong best match and three supporting passages", () => {
    expect(isIndexConfident([chunk(0.7), chunk(0.62), chunk(0.6), chunk(0.58)])).toBe(true);
    expect(isIndexConfident([chunk(0.62), chunk(0.53), chunk(0.5)])).toBe(false); // one lucky chunk
    expect(isIndexConfident([chunk(0.59), chunk(0.58), chunk(0.57)])).toBe(false); // nothing strong
    expect(isIndexConfident([])).toBe(false);
  });
});

describe("answerFromIndex", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
    mocks.embedTexts.mockReset().mockResolvedValue([[0.1]]);
  });

  it("builds the answer prompt from stored passages, one source card per page", async () => {
    mocks.queryRaw.mockResolvedValueOnce([chunk(0.7, "https://a.com"), chunk(0.65, "https://a.com"), chunk(0.6, "https://b.com")]);
    const prepared = await answerFromIndex("How does HNSW work in pgvector?");
    expect(prepared?.contextMode).toBe("index");
    expect(prepared?.contexts).toHaveLength(3);
    expect(prepared?.results.map((r) => r.url)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("goes to the web for time-sensitive questions, weak matches and embedding failures", async () => {
    expect(await answerFromIndex("latest pgvector release")).toBeNull();
    expect(mocks.embedTexts).not.toHaveBeenCalled();

    mocks.queryRaw.mockResolvedValueOnce([chunk(0.3)]);
    expect(await answerFromIndex("How does HNSW work?")).toBeNull();

    mocks.embedTexts.mockRejectedValueOnce(new Error("quota"));
    expect(await answerFromIndex("How does HNSW work?")).toBeNull();
  });
});
