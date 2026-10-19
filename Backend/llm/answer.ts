import { streamText } from "ai";
import { SYSTEM_PROMPT } from "../prompt";
import { getWebSearchResults } from "../retrieval/search";
import { buildPrompt } from "./buildPrompt";
import { ANSWER_CHAIN, providerOptionsFor, type ModelRef } from "./providers";
import type { ChatMessage } from "./stream";

export type AnswerResult = {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
};

const ANSWER_TIMEOUT_MS = 60_000;

/** Search + prompt assembly shared by the HTTP routes and the eval harness. */
export async function prepareAnswer(
  query: string,
  history: ChatMessage[] = [],
  searcher: typeof getWebSearchResults = getWebSearchResults, // evals inject a cached searcher
) {
  const search = await searcher(query);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: buildPrompt(search.queryContext, search.results, search.images) },
  ];
  return { ...search, messages };
}

/**
 * Stream one answer, trying each model in `chain` until one starts producing text.
 * Once tokens have reached the user we can't switch models, so a mid-stream failure is thrown.
 */
export async function generateAnswer(
  messages: ChatMessage[],
  onDelta?: (text: string) => void,
  { chain = ANSWER_CHAIN, maxRetries = 1 }: { chain?: ModelRef[]; maxRetries?: number } = {},
): Promise<AnswerResult> {
  let lastError: unknown = new Error("No answer models configured");

  for (const ref of chain) {
    const startedAt = performance.now();
    let content = "";
    let ttftMs = 0;

    try {
      const result = streamText({
        model: ref.model,
        messages,
        maxOutputTokens: 1500,
        maxRetries,
        abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
        providerOptions: providerOptionsFor(ref),
      });

      let promptTokens = 0;
      let completionTokens = 0;
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          if (!ttftMs) ttftMs = performance.now() - startedAt;
          content += part.text;
          onDelta?.(part.text);
        } else if (part.type === "error") {
          throw part.error;
        } else if (part.type === "finish") {
          promptTokens = part.totalUsage.inputTokens ?? 0;
          completionTokens = part.totalUsage.outputTokens ?? 0;
        }
      }

      if (!content.trim()) throw new Error(`${ref.label} returned an empty answer`);
      return { content, model: ref.label, promptTokens, completionTokens, ttftMs, totalMs: performance.now() - startedAt };
    } catch (error) {
      if (content) throw error;
      lastError = error;
      if (ref !== chain[chain.length - 1]) {
        console.warn(`[llm] ${ref.label} failed, falling back: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
  }

  throw lastError;
}
