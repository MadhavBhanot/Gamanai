import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

export type ModelRef = { provider: "google" | "groq"; modelId: string; label: string; model: LanguageModel };

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
const groq = createGroq({ apiKey: process.env.Groq_API_Key ?? "" });

/** Resolve a "provider:model" spec, e.g. "google:gemini-2.5-flash" or "groq:qwen/qwen3.8-27b". */
export function resolveModel(spec: string): ModelRef {
  const separator = spec.indexOf(":");
  const provider = spec.slice(0, separator);
  const modelId = spec.slice(separator + 1);
  if (separator < 1 || !modelId) throw new Error(`Model spec "${spec}" must look like provider:model`);
  if (provider === "google") return { provider, modelId, label: spec, model: google(modelId) };
  if (provider === "groq") return { provider, modelId, label: spec, model: groq(modelId) };
  throw new Error(`Unknown provider "${provider}" in "${spec}" (expected google or groq)`);
}

export function resolveChain(specs: string) {
  return specs.split(",").map((s) => s.trim()).filter(Boolean).map(resolveModel);
}

const DEFAULT_ANSWER_MODELS = [
  process.env.GEMINI_API_KEY ? "google:gemini-3.5-flash-lite" : null, // free-tier TTFT ~0.8s; 3.8-flash queues 40s+
  "groq:qwen/qwen3.8-27b",
].filter(Boolean).join(",");

/** Ordered fallback chain: the first model serves, later ones take over if it fails before streaming. */
export const ANSWER_CHAIN = resolveChain(process.env.ANSWER_MODELS ?? DEFAULT_ANSWER_MODELS);

/**
 * Provider-specific knobs. Thinking adds latency to a grounded-summary task (and on Flash-Lite sometimes ate the
 * whole reply), so use the lowest level each model accepts: Flash-Lite takes "minimal", 3.x Flash only "low".
 */
export function providerOptionsFor(ref: ModelRef) {
  if (ref.provider !== "google") return undefined;
  const level = process.env.GEMINI_THINKING_LEVEL ?? (ref.modelId.includes("lite") ? "minimal" : "low");
  return { google: { thinkingConfig: { thinkingLevel: level as "minimal" | "low" } } };
}
