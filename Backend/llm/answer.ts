import { CHAT_MODEL, groq } from "../config";
import { SYSTEM_PROMPT } from "../prompt";
import { getWebSearchResults } from "../retrieval/search";
import { buildPrompt } from "./buildPrompt";
import type { ChatMessage } from "./stream";

export type AnswerResult = {
  content: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  totalMs: number;
};

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

/** Stream one completion, reporting tokens via onDelta, and return content + usage + timings. */
export async function generateAnswer(
  messages: ChatMessage[],
  onDelta?: (text: string) => void,
  client = groq,
): Promise<AnswerResult> {
  const startedAt = performance.now();
  const llmStream = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    max_completion_tokens: 1500,
    stream: true,
  });

  let content = "";
  let ttftMs = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of llmStream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (text) {
      if (!ttftMs) ttftMs = performance.now() - startedAt;
      content += text;
      onDelta?.(text);
    }
    const usage = chunk.x_groq?.usage;
    if (usage) {
      promptTokens = usage.prompt_tokens;
      completionTokens = usage.completion_tokens;
    }
  }

  return { content, promptTokens, completionTokens, ttftMs, totalMs: performance.now() - startedAt };
}
