import type express from "express";
import { setSseHeaders, writeSse } from "../lib/sse";
import type { WebSearchResult } from "../retrieval/search";
import { generateAnswer } from "./answer";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function streamAiResponse({
  res,
  conversationId,
  webSearchResponse,
  messages,
  onComplete,
}: {
  res: express.Response;
  conversationId: string;
  webSearchResponse: WebSearchResult[];
  messages: ChatMessage[];
  onComplete?: (content: string) => Promise<void>;
}) {
  if (!res.headersSent) {
    setSseHeaders(res, conversationId);
  }

  writeSse(res, { type: "sources", sources: webSearchResponse });

  try {
    writeSse(res, { type: "response_start", conversationId });

    const { content } = await generateAnswer(messages, (text) =>
      writeSse(res, { type: "delta", text }),
    );

    if (content.trim() && onComplete) {
      await onComplete(content);
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
