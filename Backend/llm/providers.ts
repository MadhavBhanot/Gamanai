import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

export type ModelRef = { provider: "google" | "groq" | "nvidia"; modelId: string; label: string; model: LanguageModel };

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
const groq = createGroq({ apiKey: process.env.Groq_API_Key ?? "" });
// NVIDIA API catalog (build.nvidia.com): free developer tier, OpenAI-compatible
const nvidia = createOpenAICompatible({
  name: "nvidia",
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY ?? "",
});

/** Resolve a "provider:model" spec, e.g. "google:gemini-2.5-flash" or "groq:qwen/qwen3.8-27b". */
export function resolveModel(spec: string): ModelRef {
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (separator < 1 || !modelId) throw new Error(`Model spec "${spec}" must look like provider:model`);
  if (provider === "google") {
    // Gemma writes its reasoning inline as <think>...</think>; keep it out of the answer text
    const model = modelId.startsWith("gemma")
      ? wrapLanguageModel({ model: google(modelId), middleware: extractReasoningMiddleware({ tagName: "think" }) })
      : google(modelId);
    return { provider, modelId, label: spec, model };
  }
  if (provider === "groq") return { provider, modelId, label: spec, model: groq(modelId) };
  if (provider === "nvidia") return { provider, modelId, label: spec, model: nvidia(modelId) };
  throw new Error(`Unknown provider "${provider}" in "${spec}" (expected google, groq or nvidia)`);
}

export function resolveChain(specs: string) {
  return specs.split(",").map((s) => s.trim()).filter(Boolean).map(resolveModel);
}

const DEFAULT_ANSWER_MODELS = [
  process.env.GEMINI_API_KEY ? "google:gemini-3.5-flash-lite" : null, // free-tier TTFT ~0.8s; 3.8-flash queues 40s+
  // 14.4k requests/day but only 16k input tokens/min (~3 answers/min), so it backs up Flash-Lite. 31b took 14-55s.
  process.env.GEMINI_API_KEY ? "google:gemma-4-26b-a4b-it" : null,
  process.env.NVIDIA_API_KEY ? "nvidia:nvidia/nemotron-3-ultra-550b-a55b" : null,
  "groq:qwen/qwen3.8-27b",
].filter(Boolean).join(",");

/** Ordered fallback chain: the first model serves, later ones take over if it fails before streaming. */
export const ANSWER_CHAIN = resolveChain(process.env.ANSWER_MODELS ?? DEFAULT_ANSWER_MODELS);

/**
 * Provider-specific knobs. Thinking adds latency to a grounded-summary task (and on Flash-Lite sometimes ate the
 * whole reply), so use the lowest level each model accepts: Flash-Lite and Gemma take "minimal", 3.x Flash only "low"
 * (Gemma rejects "low" and returns 500s with no thinking config).
 */
export function providerOptionsFor(ref: ModelRef) {
  if (ref.provider !== "google") return undefined;
  const level = process.env.GEMINI_THINKING_LEVEL ?? (ref.modelId.includes("lite") || ref.modelId.startsWith("gemma") ? "minimal" : "low");
  return { google: { thinkingConfig: { thinkingLevel: level as "minimal" | "low" } } };
}
