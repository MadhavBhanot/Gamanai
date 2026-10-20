import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelRef } from "../llm/providers";
import { prepareDeepAnswer } from "../llm/research";
import { buildQueryOptimizationContext } from "../retrieval/query";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type Turn = { calls?: Array<{ toolName: string; input: object }>; text?: string };

/** A planner that plays back fixed turns: tool calls first, then a text reply that ends the loop. */
function plannerModel(turns: Turn[]): ModelRef {
  let i = 0;
  return {
    provider: "groq",
    modelId: "mock",
    label: "mock",
    model: new MockLanguageModelV3({
      doGenerate: async () => {
        const turn = turns[Math.min(i++, turns.length - 1)];
        const calls = turn.calls ?? [];
        return {
          content: calls.length
            ? calls.map((c, n) => ({ type: "tool-call" as const, toolCallId: `c${i}-${n}`, toolName: c.toolName, input: JSON.stringify(c.input) }))
            : [{ type: "text" as const, text: turn.text ?? "DONE" }],
          finishReason: { unified: calls.length ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
          usage,
          warnings: [],
        };
      },
    }),
  };
}

const searcher = async (query: string) => ({
  queryContext: buildQueryOptimizationContext(query),
  results: [
    { title: `About ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, content: `Facts on ${query}.`, sourceType: "search" as const },
    { title: "Shared page", url: "https://example.com/shared", content: "Same passage every time.", sourceType: "search" as const },
  ],
  images: [],
});

describe("prepareDeepAnswer", () => {
  it("collects passages across searches, dedupes them, and reports each step", async () => {
    const steps: string[] = [];
    const prepared = await prepareDeepAnswer("Who founded X and when?", [], {
      searcher,
      mode: "snippets",
      chain: [plannerModel([
        { calls: [{ toolName: "web_search", input: { query: "X founder" } }, { toolName: "web_search", input: { query: "X founding year" } }] },
        { text: "DONE" },
      ])],
      onStep: (s) => steps.push(`${s.index}:${s.input}:${s.found}`),
    });

    expect(prepared.steps.map((s) => s.input)).toEqual(["X founder", "X founding year"]);
    // The shared page appears in both searches but is passed to the answer model once
    expect(prepared.contexts.map((c) => c.url)).toEqual([
      "https://example.com/X%20founder",
      "https://example.com/shared",
      "https://example.com/X%20founding%20year",
    ]);
    expect(steps).toEqual(["1:X founder:2", "2:X founding year:1"]);
    expect(prepared.research.modelCalls).toBe(2);
    expect(prepared.messages.at(-1)?.content).toContain("Who founded X and when?");
    expect(prepared.messages.at(-1)?.content).toContain("[3] About X founding year");
  });

  it("fetches images in every sub-search when the user's question asks for them", async () => {
    const flags: Array<boolean | undefined> = [];
    await prepareDeepAnswer("Show me pictures of the 2024 Best Picture director", [], {
      searcher: (q, opts) => {
        flags.push(opts?.images);
        return searcher(q);
      },
      mode: "snippets",
      chain: [plannerModel([{ calls: [{ toolName: "web_search", input: { query: "Christopher Nolan" } }] }, { text: "DONE" }])],
    });
    expect(flags).toEqual([true]);
  });

  it("stops after the step limit", async () => {
    const prepared = await prepareDeepAnswer("loop forever", [], {
      searcher,
      mode: "snippets",
      chain: [plannerModel([{ calls: [{ toolName: "web_search", input: { query: "again" } }] }])],
    });
    expect(prepared.research.modelCalls).toBe(6);
  });

  it("falls back to a single search when the planner never calls a tool", async () => {
    const prepared = await prepareDeepAnswer("simple question", [], {
      searcher,
      mode: "snippets",
      chain: [plannerModel([{ text: "DONE" }])],
    });
    expect(prepared.steps).toEqual([]);
    expect(prepared.contexts).toHaveLength(2);
    expect(prepared.contextMode).toBe("snippets");
  });
});
