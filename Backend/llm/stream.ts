import type express from "express";
import type { RequestLogger } from "../lib/requestLog";
import { setSseHeaders, writeSse, writeSseStatus } from "../lib/sse";
import type { WebSearchResult } from "../retrieval/search";
import { generateAnswer } from "./answer";
import { describeStep, type ResearchStep } from "./research";
import type { SourceContext } from "./buildPrompt";
import type { CachedAnswer } from "./cache";
import { truncateText } from "../lib/text";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const QUOTE_WORDS = 6;
const PLAIN_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’.,;:%-]*$/u;

/**
 * A few words from the start of a passage for a #:~:text= link that opens the source scrolled to it.
 * Starts at a capitalised word (chunks can begin mid-sentence) and skips markdown/symbols the page won't contain.
 */
export function citationQuote(passage: string) {
  const words = passage.split(/\s+/).filter(Boolean);
  for (let i = 0; i + QUOTE_WORDS <= words.length; i++) {
    if (!/^\p{Lu}/u.test(words[i])) continue;
    const run = words.slice(i, i + QUOTE_WORDS);
    if (run.every((w) => PLAIN_WORD.test(w))) return run.join(" ").replace(/[.,;:]+$/, "");
  }
  return undefined;
}

export async function streamAiResponse({
  res,
  conversationId,
  webSearchResponse,
  messages,
  contexts = [],
  onComplete,
  log,
  researchSteps,
  signal,
}: {
  res: express.Response;
  conversationId: string;
  webSearchResponse: WebSearchResult[];
  messages: ChatMessage[];
  contexts?: SourceContext[];
  onComplete?: (content: string) => Promise<void>;
  log?: RequestLogger;
  researchSteps?: ResearchStep[];
  signal?: AbortSignal;
}) {
  if (!res.headersSent) {
    setSseHeaders(res, conversationId);
  }

  // Full page text is for retrieval only; the UI needs title/url/snippet
  writeSse(res, { type: "sources", sources: webSearchResponse.map(({ rawContent: _raw, ...source }) => source) });

  try {
    writeSse(res, { type: "response_start", conversationId });

    const { content, model, ttftMs, promptTokens, completionTokens } = await generateAnswer(
      messages,
      (text) => writeSse(res, { type: "delta", text }),
      { signal },
    );
    log?.finish({ ok: true, model, ttftMs, promptTokens, completionTokens, researchSteps: researchSteps?.length, sourceCount: webSearchResponse.length });

    // [n] in the answer refers to contexts[n-1]; ship the mapping as the last chunk and persist it with the
    // message so citations still link after a reload.
    const citations = contexts.length
      ? `\n<CITATIONS>${// snippet feeds the hover preview on [n] chips
      JSON.stringify(contexts.map(({ url, title, text }) => ({ url, title, quote: citationQuote(text), snippet: truncateText(text.replace(/\s+/g, " "), 220) })))}</CITATIONS>`
      : "";
    if (citations) writeSse(res, { type: "delta", text: citations });

    // Deep mode's steps are saved (not streamed: the client already showed them live) so the trace survives a reload
    const traceLines = (researchSteps ?? []).map((step, i) => {
      const { label, detail } = describeStep(step, i + 1);
      return `${label}: ${detail}`;
    });
    const trace = traceLines.length ? `\n<RESEARCH>${JSON.stringify(traceLines)}</RESEARCH>` : "";

    if (content.trim() && onComplete) {
      await onComplete(content + citations + trace);
    }

    writeSse(res, { type: "response_end", conversationId });
  } catch (error) {
    if (signal?.aborted) {
      // The client left (Stop button); nobody is listening, so just record it
      log?.finish({ ok: false, error: "stopped by client", researchSteps: researchSteps?.length });
      return;
    }
    console.error("AI stream failed", error);
    log?.finish({ ok: false, error: String((error as Error)?.message ?? error), researchSteps: researchSteps?.length });
    writeSse(res, {
      type: "error",
      error: "AI response failed",
      conversationId,
    });
    writeSse(res, { type: "response_end", conversationId });
  } finally {
    res.end();
  }
}

/** Replay a cached answer with the same events a live answer sends, so the client needs no special case. */
export function replayCachedAnswer(res: express.Response, conversationId: string, cached: CachedAnswer, log?: RequestLogger) {
  writeSseStatus(res, conversationId, "Answered from cache", "The same question was answered in the last 24 hours.");
  writeSse(res, { type: "sources", sources: cached.sources });
  writeSse(res, { type: "response_start", conversationId });
  writeSse(res, { type: "delta", text: cached.content });
  writeSse(res, { type: "response_end", conversationId });
  log?.finish({ ok: true, model: "cache", sourceCount: cached.sources.length });
  res.end();
}
