import { afterEach, describe, expect, it, vi } from "vitest";

describe("embedTexts with an nvidia: model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("batches requests, sends the task type, and keeps input order", async () => {
    vi.stubEnv("EMBEDDING_MODEL", "nvidia:nvidia/nemotron-3.5-embed-8b");
    const bodies: { model: string; input: string[]; input_type: string; dimensions: number }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      // Returned out of order on purpose; the client must sort by index
      const data = body.input.map((text: string, index: number) => ({ index, embedding: [text.length] })).reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }));
    const { embedTexts } = await import("../retrieval/embed");

    const values = Array.from({ length: 60 }, (_, i) => "x".repeat(i + 1));
    const result = await embedTexts(values, "document");

    expect(bodies.map((b) => b.input.length)).toEqual([50, 10]);
    expect(bodies[0]).toMatchObject({ model: "nvidia/nemotron-3.5-embed-8b", input_type: "passage", dimensions: 768 });
    expect(result.map((e) => e[0])).toEqual(values.map((v) => v.length));
  });

  it("throws on an API error so retrieval can fall back", async () => {
    vi.stubEnv("EMBEDDING_MODEL", "nvidia:nvidia/nemotron-3.5-embed-8b");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    const { embedTexts } = await import("../retrieval/embed");
    await expect(embedTexts(["a"], "query")).rejects.toThrow("NVIDIA embeddings 429");
  });
});
