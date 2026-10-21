import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { cleanRewrite, conversationTranscript, keepUrls, plainAnswer, standaloneQuery } from "../llm/contextualize";
import type { ModelRef } from "../llm/providers";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

function model(label: string, reply: string | Error): ModelRef {
  const doGenerate = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return { content: [{ type: "text" as const, text: reply }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] };
  });
  return { provider: "google", modelId: label, label, model: new MockLanguageModelV3({ doGenerate }) };
}

const worldCup = [
  { role: "user" as const, content: "who won the 2022 world cup?" },
  { role: "assistant" as const, content: "<ANSWER>Argentina beat France on penalties [1].</ANSWER><CITATIONS>[{\"url\":\"https://x\"}]</CITATIONS>" },
];

describe("transcript helpers", () => {
  it("keeps only the answer text from stored assistant messages", () => {
    expect(plainAnswer(worldCup[1].content)).toBe("Argentina beat France on penalties .");
    expect(conversationTranscript(worldCup)).toBe("User: who won the 2022 world cup?\nAssistant: Argentina beat France on penalties .");
  });

  it("cleans labels and quotes, rejects empty or runaway replies", () => {
    expect(cleanRewrite('Question: "What was Argentina\'s lineup?"\nextra')).toBe("What was Argentina's lineup?");
    expect(cleanRewrite("   ")).toBeNull();
    expect(cleanRewrite("x".repeat(500))).toBeNull();
  });

  it("puts back URLs the rewrite dropped", () => {
    expect(keepUrls("summarize https://a.com/x", "Summary of the article")).toBe("Summary of the article https://a.com/x");
    expect(keepUrls("summarize https://a.com/x", "Summarize https://a.com/x")).toBe("Summarize https://a.com/x");
  });
});

describe("standaloneQuery", () => {
  it("skips the model when there is no history", async () => {
    const m = model("m", "should not be used");
    expect(await standaloneQuery("who won?", [], { chain: [m] })).toBe("who won?");
    expect(m.model).toBeInstanceOf(MockLanguageModelV3);
    expect((m.model as MockLanguageModelV3).doGenerateCalls).toHaveLength(0);
  });

  it("falls through the chain and returns the first usable rewrite", async () => {
    const result = await standaloneQuery("what was their lineup like", worldCup, {
      chain: [model("down", new Error("503")), model("up", "What was Argentina's lineup in the 2022 World Cup final?")],
    });
    expect(result).toBe("What was Argentina's lineup in the 2022 World Cup final?");
  });

  it("returns the original question when every model fails", async () => {
    expect(await standaloneQuery("what was their lineup like", worldCup, { chain: [model("down", new Error("503"))] })).toBe(
      "what was their lineup like",
    );
  });
});
