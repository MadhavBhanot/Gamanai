import type express from "express";
import { CHAT_MODEL, groq } from "../config";
import { setSseHeaders, writeSse } from "../lib/sse";
import type { WebSearchResult } from "../retrieval/search";

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
    const llmStream = await groq.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      max_completion_tokens: 1500,
      stream: true,
    });

    writeSse(res, { type: "response_start", conversationId });

    let assistantContent = "";
    for await (const chunk of llmStream) {
      const content = chunk.choices[0]?.delta?.content ?? "";

      if (content) {
        assistantContent += content;
        writeSse(res, { type: "delta", text: content });
      }
    }

    if (assistantContent.trim() && onComplete) {
      await onComplete(assistantContent);
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
