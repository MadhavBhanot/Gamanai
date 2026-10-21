import { generateText } from "ai";
import { truncateText } from "../lib/text";
import { telemetry } from "../lib/tracing";
import { stripInjections } from "./guard";
import { providerOptionsFor, resolveChain, type ModelRef } from "./providers";

/**
 * Follow-up questions ("what was their lineup like?") are vague on their own. Before searching, rewrite the
 * latest message into a standalone question using the recent turns, including the previous answers, which is
 * where "their" gets its meaning. Any failure returns the message unchanged, so this can never block an answer.
 */

// A small fast model with its own quota keeps Flash-Lite's 500/day for answers
const REWRITE_CHAIN = resolveChain(process.env.REWRITE_MODELS ?? "groq:openai/gpt-oss-20b,google:gemini-3.5-flash-lite");
const REWRITE_TIMEOUT_MS = 6_000;
const RECENT_TURNS = 6;
const TURN_CHARS = 600;
const MAX_QUERY_CHARS = 400;

const REWRITE_PROMPT = `You rewrite the user's latest message into a standalone question for a web search.
Use the conversation only to resolve references: pronouns (they, it, their, he, she), "that", "the second one", subjects the user left out, and definite descriptions that point back at the conversation ("the helicopter", "the losing side", "k") - name the specific thing and its topic.
A search engine sees only your question, so it must make sense without the conversation.
Keep the user's intent, language and any URLs. Do not answer the question and do not add facts the conversation doesn't contain.
If the latest message starts a new topic, return it unchanged.
Reply with only the question, on one line.`;

export type Turn = { role: "user" | "assistant" | "system"; content: string };

/** Answer text without the markup the app stores with it (sources, research trace, follow-up chips, [n]). */
export function plainAnswer(content: string) {
  const answer = content.match(/<ANSWER>([\s\S]*?)(<\/ANSWER>|<FOLLOW_UPS>|$)/i)?.[1] ?? content;
  return answer
    .replace(/<(CITATIONS|RESEARCH|METRICS|FOLLOW_UPS|think)>[\s\S]*?(<\/\1>|$)/gi, " ")
    .replace(/\[\d{1,2}\](\([^)]*\))?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function conversationTranscript(history: Turn[]) {
  return history
    .filter((t) => t.role !== "system")
    .slice(-RECENT_TURNS)
    .map((t) => {
      // Answers quote fetched pages, so they get the same injection stripping as sources
      const text = t.role === "assistant" ? stripInjections(plainAnswer(t.content)) : t.content.trim();
      return `${t.role === "user" ? "User" : "Assistant"}: ${truncateText(text, TURN_CHARS)}`;
    })
    .filter((line) => !/:\s*$/.test(line))
    .join("\n");
}

/** First line of the model's reply, without quotes or a "Question:" label; null when it isn't usable. */
export function cleanRewrite(text: string) {
  const line = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim().split("\n")[0]?.trim() ?? "";
  const cleaned = line.replace(/^(standalone )?(question|query)\s*:\s*/i, "").replace(/^["'“]|["'”]$/g, "").trim();
  return cleaned && cleaned.length <= MAX_QUERY_CHARS ? cleaned : null;
}

/** The URL feature keys off links in the question, so a rewrite must not drop them. */
export function keepUrls(original: string, rewritten: string) {
  const missing = (original.match(/https?:\/\/\S+/g) ?? []).filter((url) => !rewritten.includes(url));
  return missing.length ? `${rewritten} ${missing.join(" ")}` : rewritten;
}

const rewriteOptions = (ref: ModelRef) =>
  ref.provider === "groq" ? { groq: { reasoningEffort: "low" } } : providerOptionsFor(ref);

export async function standaloneQuery(query: string, history: Turn[], { chain = REWRITE_CHAIN, signal }: { chain?: ModelRef[]; signal?: AbortSignal } = {}) {
  const transcript = conversationTranscript(history);
  if (!transcript) return query;

  for (const ref of chain) {
    try {
      const { text } = await generateText({
        model: ref.model,
        system: REWRITE_PROMPT,
        prompt: `Conversation:\n${transcript}\n\nLatest message: ${query}`,
        temperature: 0,
        maxOutputTokens: 600, // gpt-oss reasons before answering; the reply itself is one line
        maxRetries: 0,
        abortSignal: signal ? AbortSignal.any([AbortSignal.timeout(REWRITE_TIMEOUT_MS), signal]) : AbortSignal.timeout(REWRITE_TIMEOUT_MS),
        providerOptions: rewriteOptions(ref),
        experimental_telemetry: telemetry("follow-up-rewrite"),
      });
      const rewritten = cleanRewrite(text);
      if (rewritten) return keepUrls(query, rewritten);
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`[contextualize] ${ref.label} failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    }
  }
  return query;
}
