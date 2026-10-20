import { generateText, stepCountIs, tool, type StopCondition, type ToolSet } from "ai";
import { z } from "zod";
import { truncateText } from "../lib/text";
import { buildQueryOptimizationContext, dedupeStrings } from "../retrieval/query";
import { dedupeWebSearchResults, getWebSearchResults, type WebSearchResult } from "../retrieval/search";
import { answerMessages, buildContexts, CONTEXT_MODE, prepareAnswer, type ContextMode, type PreparedAnswer } from "./answer";
import type { SourceContext } from "./buildPrompt";
import { ANSWER_CHAIN, providerOptionsFor, type ModelRef } from "./providers";
import type { ChatMessage } from "./stream";

// Hard limits so one deep question can't drain the free-tier quotas.
const MAX_STEPS = 6;
const RESEARCH_TIMEOUT_MS = 60_000;
const RESEARCH_INPUT_TOKEN_BUDGET = 40_000;
const PASSAGES_PER_SEARCH = 3;
// Groq's free tier rejects requests over 7k tokens (prompt + max output); 12 passages measured 7.2k
const MAX_CONTEXTS = 10;

const RESEARCH_PROMPT = `You are the research planner for Gaminai, a web research assistant.
Break the user's question into the sub-questions needed to answer it fully, then gather evidence:
- Call web_search once per sub-question with a short keyword query. Run independent searches in the same step.
- Make every query self-contained: name the specific people, titles, places and years (never a bare word like "director").
  When a later sub-question depends on an earlier answer, search for it only after you have that answer.
- Call extract_url to read one specific page: a URL the user gave, or a result that looks essential.
- Read what each tool returns. Search again only for the parts that are still missing.
- Stop as soon as the passages cover every sub-question, and reply with the single word DONE.
Do not write the answer yourself; another step writes it from the passages you collect.`;

export type ResearchStep = { tool: "web_search" | "extract_url"; input: string; found: number };

export type DeepPreparedAnswer = PreparedAnswer & {
  steps: ResearchStep[];
  research: { modelCalls: number; inputTokens: number; outputTokens: number; ms: number; model?: string };
};

/**
 * Deep research: an agent loop decides what to search, collects numbered passages across several searches,
 * then the normal answer step writes one cited answer from them. Returns the same shape as prepareAnswer,
 * so routes and evals can swap one for the other.
 */
export async function prepareDeepAnswer(
  query: string,
  history: ChatMessage[] = [],
  {
    searcher = getWebSearchResults,
    mode = CONTEXT_MODE,
    chain = ANSWER_CHAIN,
    onStep,
    maxRetries = 2,
  }: {
    searcher?: typeof getWebSearchResults;
    mode?: ContextMode;
    chain?: ModelRef[];
    onStep?: (step: ResearchStep & { index: number }) => void;
    maxRetries?: number;
  } = {},
): Promise<DeepPreparedAnswer> {
  const startedAt = performance.now();
  const contexts: SourceContext[] = [];
  const results: WebSearchResult[] = [];
  const images: string[] = [];
  const steps: ResearchStep[] = [];
  let usedMode: ContextMode = mode;

  async function gather(toolName: ResearchStep["tool"], input: string) {
    try {
      // The searcher extracts any URL in its query, so extract_url is a search on the URL itself.
      const search = await searcher(input);
      const found = await buildContexts(input, search.results, mode);
      if (found.mode !== mode) usedMode = found.mode;
      const fresh = found.contexts
        .slice(0, PASSAGES_PER_SEARCH)
        .filter((c) => !contexts.some((e) => e.url === c.url && e.text === c.text))
        .slice(0, MAX_CONTEXTS - contexts.length);
      contexts.push(...fresh);
      results.push(...search.results);
      if (fresh.length) images.push(...search.images);
      const step = { tool: toolName, input, found: fresh.length };
      steps.push(step);
      onStep?.({ ...step, index: steps.length });
      return fresh.length
        ? fresh.map((c) => `${c.title} (${c.url})\n${truncateText(c.text, 500)}`).join("\n\n")
        : "No new passages; try a different query.";
    } catch (error) {
      return `Search failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`;
    }
  }

  const tools = {
    web_search: tool({
      description: "Search the web. Returns the most relevant passages for the query.",
      inputSchema: z.object({ query: z.string().min(1).describe("Short keyword search query") }),
      execute: ({ query: q }) => gather("web_search", q),
    }),
    extract_url: tool({
      description: "Read one web page by URL. Returns the passages most relevant to the user's question.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }) => gather("extract_url", url),
    }),
  } satisfies ToolSet;

  const stopWhen: StopCondition<typeof tools>[] = [
    stepCountIs(MAX_STEPS),
    () => contexts.length >= MAX_CONTEXTS,
    ({ steps: done }) => done.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0) > RESEARCH_INPUT_TOKEN_BUDGET,
  ];

  const research = { modelCalls: 0, inputTokens: 0, outputTokens: 0, ms: 0, model: undefined as string | undefined };
  let lastError: unknown;
  for (const ref of chain) {
    try {
      const result = await generateText({
        model: ref.model,
        system: RESEARCH_PROMPT,
        messages: [...history.filter((m) => m.role !== "system"), { role: "user", content: query }],
        tools,
        stopWhen,
        maxRetries,
        abortSignal: AbortSignal.timeout(RESEARCH_TIMEOUT_MS),
        providerOptions: providerOptionsFor(ref),
      });
      research.modelCalls += result.steps.length;
      research.inputTokens += result.totalUsage.inputTokens ?? 0;
      research.outputTokens += result.totalUsage.outputTokens ?? 0;
      research.model = ref.label;
      break;
    } catch (error) {
      lastError = error;
      // Out of time or budget mid-loop: answer from what was already gathered
      if (contexts.length) {
        research.model = ref.label;
        break;
      }
      console.warn(`[research] ${ref.label} failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
  }
  research.ms = performance.now() - startedAt;

  if (!contexts.length) {
    // The planner failed or never searched: fall back to the single-shot pipeline
    if (lastError) console.warn("[research] falling back to quick mode");
    return { ...(await prepareAnswer(query, history, searcher, mode)), steps, research };
  }

  const search = {
    queryContext: buildQueryOptimizationContext(query),
    // Only pages that supplied a passage; the rest of each search's results never reach the answer
    results: dedupeWebSearchResults(results.filter((r) => contexts.some((c) => c.url === r.url))),
    images: dedupeStrings(images),
  };
  return {
    ...search,
    contexts,
    contextMode: usedMode,
    retrievalMs: research.ms,
    messages: answerMessages(search, contexts, history),
    steps,
    research,
  };
}
