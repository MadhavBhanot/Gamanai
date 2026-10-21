import { streamText } from "ai";
import { truncateText } from "../lib/text";
import { SYSTEM_PROMPT } from "../prompt";
import { indexPages, retrieveChunks, type RetrievalMode } from "../retrieval/hybrid";
import { indexFirstEnabled, isIndexConfident, searchIndex } from "../retrieval/indexFirst";
import { buildQueryOptimizationContext } from "../retrieval/query";
import { liveImageUrls } from "../retrieval/images";
import { getWebSearchResults, type WebSearchResult } from "../retrieval/search";
import { buildPrompt, type SourceContext } from "./buildPrompt";
import { isCacheable } from "./cache";
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
const CONTEXT_CHUNKS = 8;
const SNIPPET_CHARS = 600;

/** "snippets" = the pre-retrieval behaviour (one 600-char search snippet per page); kept for ablations and as fallback. */
export type ContextMode = RetrievalMode | "snippets";
export const CONTEXT_MODE = (process.env.RETRIEVAL_MODE ?? "hybrid") as ContextMode;

function snippetContexts(results: WebSearchResult[]): SourceContext[] {
  return results.map((r) => ({ url: r.url, title: r.title, text: truncateText(r.content, SNIPPET_CHARS) }));
}

/** Pick the passages the model sees: retrieved chunks from full pages, or plain snippets. */
export async function buildContexts(query: string, results: WebSearchResult[], mode: ContextMode = CONTEXT_MODE) {
  if (mode === "snippets") return { contexts: snippetContexts(results), mode };
  try {
    await indexPages(results.map((r) => ({ url: r.url, title: r.title, text: r.rawContent || r.content })));
    const chunks = await retrieveChunks(query, results.map((r) => r.url), { k: CONTEXT_CHUNKS, mode });
    if (chunks.length) {
      return { contexts: chunks.map((c) => ({ url: c.url, title: c.title, text: c.content })), mode };
    }
  } catch (error) {
    // DB or embedding outage shouldn't take answers down with it
    console.error(`[retrieval] ${mode} failed, using snippets:`, String((error as Error)?.message ?? error).slice(0, 200));
  }
  return { contexts: snippetContexts(results), mode: "snippets" as const };
}

/** Search + retrieval + prompt assembly shared by the HTTP routes and the eval harness. */
export async function prepareAnswer(
  query: string,
  history: ChatMessage[] = [],
  searcher: typeof getWebSearchResults = getWebSearchResults, // evals inject a cached searcher
  mode: ContextMode = CONTEXT_MODE,
) {
  const search = await searcher(query);
  const retrievalStartedAt = performance.now();
  const { contexts, mode: usedMode } = await buildContexts(query, search.results, mode);
  const retrievalMs = performance.now() - retrievalStartedAt;
  const messages = await answerMessages(search, contexts, history);
  return { ...search, contexts, contextMode: usedMode, retrievalMs, messages };
}

export type PreparedAnswer = Awaited<ReturnType<typeof prepareAnswer>>;

/**
 * Answer from passages stored by earlier searches when they clearly cover the question; null means "search the web".
 * Time-sensitive and URL questions always go to the web, and any failure (e.g. embedding quota) falls through.
 */
export async function answerFromIndex(query: string, history: ChatMessage[] = []) {
  if (!indexFirstEnabled() || !isCacheable(query)) return null;
  const startedAt = performance.now();
  let chunks;
  try {
    chunks = await searchIndex(query);
  } catch (error) {
    console.warn(`[index-first] skipped: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return null;
  }
  if (!isIndexConfident(chunks)) return null;

  const contexts: SourceContext[] = chunks.map((c) => ({ url: c.url, title: c.title, text: c.content }));
  // One source card per page, scored by its best passage
  const results: WebSearchResult[] = [...new Map(chunks.map((c) => [c.url, c])).values()].map((c) => ({
    title: c.title,
    url: c.url,
    content: truncateText(c.content, 300),
    score: c.similarity,
    sourceType: "search",
  }));
  const search = { queryContext: buildQueryOptimizationContext(query), results, images: [] as string[] };
  const messages = await answerMessages(search, contexts, history);
  return { ...search, contexts, contextMode: "index" as const, retrievalMs: performance.now() - startedAt, messages };
}

/** The answer model's input: system prompt, history, then the numbered sources and the query. */
export async function answerMessages(
  search: Awaited<ReturnType<typeof getWebSearchResults>>,
  contexts: SourceContext[],
  history: ChatMessage[] = [],
): Promise<ChatMessage[]> {
  // Dead image links rendered as broken images; only offer the model images that load right now
  const imageUrls = [...search.results.flatMap((r) => r.images ?? []), ...search.images];
  const live = new Set(imageUrls.length ? await liveImageUrls(imageUrls) : []);
  const results = search.results.map((r) => (r.images?.length ? { ...r, images: r.images.filter((u) => live.has(u)) } : r));
  const images = search.images.filter((u) => live.has(u));
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: buildPrompt(search.queryContext, contexts, results, images) },
  ];
}

/**
 * Stream one answer, trying each model in `chain` until one starts producing text.
 * Once tokens have reached the user we can't switch models, so a mid-stream failure is thrown.
 */
export async function generateAnswer(
  messages: ChatMessage[],
  onDelta?: (text: string) => void,
  { chain = ANSWER_CHAIN, maxRetries = 1, signal }: { chain?: ModelRef[]; maxRetries?: number; signal?: AbortSignal } = {},
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
        abortSignal: signal ? AbortSignal.any([AbortSignal.timeout(ANSWER_TIMEOUT_MS), signal]) : AbortSignal.timeout(ANSWER_TIMEOUT_MS),
        providerOptions: providerOptionsFor(ref),
        onError: () => {}, // errors surface as "error" parts below; the SDK default would also console.error them
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
      // Stopped by the client: don't wake the next model in the chain
      if (content || signal?.aborted) throw error;
      lastError = error;
      if (ref !== chain[chain.length - 1]) {
        console.warn(`[llm] ${ref.label} failed, falling back: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
  }

  throw lastError;
}
