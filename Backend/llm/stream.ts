import type express from "express";
import { setSseHeaders, writeSse } from "../lib/sse";
import type { WebSearchResult } from "../retrieval/search";
import { generateAnswer } from "./answer";
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
}: {
  res: express.Response;
  conversationId: string;
  webSearchResponse: WebSearchResult[];
  messages: ChatMessage[];
  contexts?: SourceContext[];
  onComplete?: (content: string) => Promise<void>;
}) {
  if (!res.headersSent) {
    setSseHeaders(res, conversationId);
  }

  // Full page text is for retrieval only; the UI needs title/url/snippet
  writeSse(res, { type: "sources", sources: webSearchResponse.map(({ rawContent: _raw, ...source }) => source) });

  try {
    writeSse(res, { type: "response_start", conversationId });

    const { content } = await generateAnswer(messages, (text) =>
      writeSse(res, { type: "delta", text }),
    );

    // [n] in the answer refers to contexts[n-1]; ship the mapping as the last chunk and persist it with the
    // message so citations still link after a reload.
    const citations = contexts.length
      ? `\n<CITATIONS>${JSON.stringify(contexts.map(({ url, title }) => ({ url, title })))}</CITATIONS>`
      : "";
    if (citations) writeSse(res, { type: "delta", text: citations });

    if (content.trim() && onComplete) {
      await onComplete(content + citations);
    }

    writeSse(res, { type: "response_end", conversationId });
  } catch (error) {
    console.error("AI stream failed", error);
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
