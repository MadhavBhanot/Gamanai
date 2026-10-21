import { afterEach, describe, expect, it, vi } from "vitest";

// EMBEDDING_MODEL is read when embed.ts loads, so set it before the import below
vi.hoisted(() => {
  process.env.EMBEDDING_MODEL = "nvidia:nvidia/nemotron-3.5-embed-8b";
});
import { embedTexts } from "../retrieval/embed";

describe("embedTexts with an nvidia: model", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("batches requests, sends the task type, and keeps input order", async () => {
    const bodies: { model: string; input: string[]; input_type: string; dimensions: number }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      // Returned out of order on purpose; the client must sort by index
      const data = body.input.map((text: string, index: number) => ({ index, embedding: [text.length] })).reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }));

    const values = Array.from({ length: 60 }, (_, i) => "x".repeat(i + 1));
    const result = await embedTexts(values, "document");

    expect(bodies.map((b) => b.input.length)).toEqual([50, 10]);
    expect(bodies[0]).toMatchObject({ model: "nvidia/nemotron-3.5-embed-8b", input_type: "passage", dimensions: 768 });
    expect(result.map((e: number[]) => e[0])).toEqual(values.map((v) => v.length));
  });

  it("throws on an API error so retrieval can fall back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    await expect(embedTexts(["a"], "query")).rejects.toThrow("NVIDIA embeddings 429");
  });
});
