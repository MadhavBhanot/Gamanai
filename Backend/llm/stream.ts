import type express from "express";
import type { RequestLogger } from "../lib/requestLog";
import { setSseHeaders, writeSse } from "../lib/sse";
import type { WebSearchResult } from "../retrieval/search";
import { generateAnswer } from "./answer";
import { describeStep, type ResearchStep } from "./research";
import type { SourceContext } from "./buildPrompt";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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
      ? `\n<CITATIONS>${JSON.stringify(contexts.map(({ url, title }) => ({ url, title })))}</CITATIONS>`
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
