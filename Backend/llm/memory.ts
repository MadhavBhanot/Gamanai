import { generateText } from "ai";
import { CONTEXT_SUMMARY_PROMPT } from "../prompt";
import { truncateText } from "../lib/text";
import { ANSWER_CHAIN, providerOptionsFor } from "./providers";
import type { ChatMessage } from "./stream";

// ponytail: not wired into /follow_up yet (it only sends the last 5 user queries).
// Hook it up behind the eval harness so the quality change is measured.

const SUMMARY_RECENT_MESSAGE_LIMIT = 10;
const SUMMARY_MESSAGE_CHAR_LIMIT = 320;
const SUMMARY_USER_QUERY_CHAR_LIMIT = 180;

export function buildContextSnapshot(history: ChatMessage[]) {
  const userQueries = history
    .filter((message) => message.role === "user")
    .map(
      (message, index) =>
        `${index + 1}. ${truncateText(message.content, SUMMARY_USER_QUERY_CHAR_LIMIT)}`,
    );
  const recentMessages = history
    .slice(-SUMMARY_RECENT_MESSAGE_LIMIT)
    .map(
      (message) =>
        `[${message.role.toUpperCase()}]: ${truncateText(
          message.content,
          SUMMARY_MESSAGE_CHAR_LIMIT,
        )}`,
    );

  return [
    "## User Query Timeline",
    userQueries.length ? userQueries.join("\n") : "- None",
    "",
    `## Recent Conversation (${Math.min(history.length, SUMMARY_RECENT_MESSAGE_LIMIT)} messages)`,
    recentMessages.length ? recentMessages.join("\n\n") : "- None",
  ].join("\n");
}

function buildFallbackContextSummary(history: ChatMessage[]) {
  const userQueries = history
    .filter((message) => message.role === "user")
    .map(
      (message, index) =>
        `- Query ${index + 1}: ${truncateText(
          message.content,
          SUMMARY_USER_QUERY_CHAR_LIMIT,
        )}`,
    );
  const recentMessages = history
    .slice(-SUMMARY_RECENT_MESSAGE_LIMIT)
    .map(
      (message) =>
        `- Recent ${message.role}: ${truncateText(
          message.content,
          SUMMARY_MESSAGE_CHAR_LIMIT,
        )}`,
    );

  return [...userQueries, ...recentMessages].join("\n");
}

/**
 * Generate a bulleted context summary from raw conversation history.
 * This avoids sending the full history to the LLM on long conversations.
 */
export async function generateContextSummary(history: ChatMessage[]): Promise<string> {
  const prompt = CONTEXT_SUMMARY_PROMPT.replace(
    "{{CONVERSATION_HISTORY}}",
    () => buildContextSnapshot(history),
  );

  try {
    const ref = ANSWER_CHAIN[0];
    const { text } = await generateText({
      model: ref.model,
      prompt,
      maxOutputTokens: 500,
      providerOptions: providerOptionsFor(ref),
    });

    return text.trim() || "No context summary available.";
  } catch (error) {
    console.error("Context summary generation failed", error);
    return buildFallbackContextSummary(history);
  }
}
