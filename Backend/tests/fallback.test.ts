import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { generateAnswer } from "../llm/answer";
import type { ModelRef } from "../llm/providers";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};

function streamingModel(label: string, chunks: string[], failAfter?: boolean): ModelRef {
  const parts = [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t" },
    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
    ...(failAfter
      ? [{ type: "error" as const, error: new Error(`${label} died mid-stream`) }]
      : [
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
        ]),
  ];
  return {
    provider: "groq",
    modelId: label,
    label,
    model: new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) }),
    }),
  };
}

function failingModel(label: string): ModelRef {
  return {
    provider: "google",
    modelId: label,
    label,
    model: new MockLanguageModelV3({
      doStream: async () => {
        throw new Error(`${label} is down`);
      },
    }),
  };
}

const messages = [{ role: "user" as const, content: "hi" }];

describe("generateAnswer provider fallback", () => {
  it("uses the first model when it works", async () => {
    const result = await generateAnswer(messages, undefined, {
      chain: [streamingModel("primary", ["Hel", "lo"]), streamingModel("backup", ["no"])],
      maxRetries: 0,
    });
    expect(result.content).toBe("Hello");
    expect(result.model).toBe("primary");
    expect(result.promptTokens).toBe(10);
  });

  it("falls back when the primary fails before streaming", async () => {
    const deltas: string[] = [];
    const result = await generateAnswer(messages, (t) => deltas.push(t), {
      chain: [failingModel("gemini"), streamingModel("groq", ["ok"])],
      maxRetries: 0,
    });
    expect(result.model).toBe("groq");
    expect(deltas).toEqual(["ok"]);
  });

  it("does not switch models once text reached the user", async () => {
    await expect(
      generateAnswer(messages, undefined, {
        chain: [streamingModel("primary", ["partial"], true), streamingModel("backup", ["x"])],
        maxRetries: 0,
      }),
    ).rejects.toThrow(/mid-stream/);
  });

  it("does not fall back when the client stopped the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const backup = streamingModel("backup", ["should not run"]);
    const backupStream = vi.spyOn(backup.model as MockLanguageModelV3, "doStream");
    await expect(
      generateAnswer(messages, undefined, { chain: [streamingModel("primary", ["x"]), backup], maxRetries: 0, signal: controller.signal }),
    ).rejects.toThrow();
    expect(backupStream).not.toHaveBeenCalled();
  });

  it("throws the last error when every model fails", async () => {
    await expect(
      generateAnswer(messages, undefined, { chain: [failingModel("a"), failingModel("b")], maxRetries: 0 }),
    ).rejects.toThrow(/b is down/);
  });
});
