/**
 * Prompt-injection guard for fetched web text. Pages are data, but a page can contain text addressed to the model
 * ("ignore previous instructions and ..."). Sentences that read as instructions to an AI are replaced before the
 * text reaches any prompt; the system prompt also tells the model that sources are untrusted.
 * shortcut: keyword heuristics, so an article *about* prompt injection loses those sentences too; move to a
 * classifier if the canary eval or real traffic shows misses or too many false positives.
 */
const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.!?\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  /\b(you are|act as|pretend to be|you're) now\b/i,
  /\b(new|updated|real|hidden) (system )?(instructions?|prompt)s?\s*:/i,
  /\bsystem prompt\b/i,
  /\b(assistant|AI|language model|LLM|chatbot)s?\b[^.!?\n]{0,40}\b(must|should|will) (now )?(respond|reply|answer|say|output|print|include)\b/i,
  /\b(respond|reply|answer) (only )?with (the word|exactly|only)\b/i,
];

export const REMOVED_MARKER = "[removed: instruction-like text]";

/** Replace instruction-like sentences in fetched text. */
export function stripInjections(text: string) {
  return text.replace(/[^.!?\n]*[.!?]?/g, (sentence) =>
    INSTRUCTION_PATTERNS.some((p) => p.test(sentence)) ? ` ${REMOVED_MARKER} ` : sentence,
  );
}
