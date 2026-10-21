import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../instrumentation", () => ({ tracingEnabled: true }));
import { listPriceUsd, toRegExp } from "../llm/pricing";

describe("listPriceUsd", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prices input and output tokens with the matching Langfuse model, and skips unpriced models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        { matchPattern: "(?i)^(gemini-3.5-flash-lite)$", inputPrice: 3e-7, outputPrice: 2.5e-6 },
        { matchPattern: "(?i)^(gemma-4)$", inputPrice: null, outputPrice: null },
      ],
    }))));
    // Same numbers Langfuse showed for a real answer: 2865 in, 423 out => $0.0008595 + $0.0010575
    expect(await listPriceUsd("google:gemini-3.5-flash-lite", 2865, 423)).toBeCloseTo(0.001917, 6);
    expect(await listPriceUsd("google:gemma-4-26b-a4b-it", 1000, 100)).toBeUndefined();
  });

  it("reads Langfuse's (?i) prefix as a case-insensitive flag", () => {
    expect(toRegExp("(?i)^gemini").test("GEMINI-x")).toBe(true);
  });
});
