import { generateText, Output } from "ai";
import { z } from "zod";
import { truncateText } from "../lib/text";
import { resolveModel } from "../llm/providers";
import type { WebSearchResult } from "../retrieval/search";
import type { EvalCase } from "./metrics";

// A different model (and quota) from the answerer. Same family as a Gemini answerer, so self-preference
// bias is possible: the human-label calibration (calibrate.ts) is the check on that.
// gemini-3.6-flash would be stronger but its free tier allows only 20 requests/day; Flash-Lite quotas fit a 100-case run.
export const JUDGE = resolveModel(process.env.JUDGE_MODEL ?? "google:gemini-3.1-flash-lite");

const verdictSchema = z.object({
  key_facts_covered: z.array(z.boolean()),
  contradicts_key_facts: z.boolean(),
  claims_total: z.number().int().min(0),
  claims_supported: z.number().int().min(0),
  handled_false_premise: z.boolean().nullable(),
  rationale: z.string(),
});

export type Verdict = z.infer<typeof verdictSchema>;

const JUDGE_PROMPT = `You are a strict evaluator of a web research assistant. Return ONLY a JSON object.

Inputs: the user QUESTION, REFERENCE key facts written by a human, the SOURCES the assistant was given, and the assistant ANSWER.

Produce:
- "key_facts_covered": one boolean per reference key fact, in order. true only if the answer states that fact (paraphrase is fine).
- "contradicts_key_facts": true if the answer asserts something that contradicts any reference fact.
- "claims_total": number of distinct factual claims in the answer (ignore filler, headings, and follow-up suggestions).
- "claims_supported": how many of those claims are directly supported by the SOURCES text. Judge ONLY against SOURCES, not your own knowledge.
- "handled_false_premise": if FALSE_PREMISE is true, true when the answer rejects or corrects the false premise (or declines to give private data) instead of playing along; otherwise null.
- "rationale": one short sentence.`;

export async function judgeAnswer(
  testCase: EvalCase,
  sources: WebSearchResult[],
  answer: string,
): Promise<Verdict> {
  const prompt = JSON.stringify({
    QUESTION: testCase.query,
    FALSE_PREMISE: testCase.should_refuse,
    REFERENCE_KEY_FACTS: testCase.key_facts,
    // Same snippet budget the answerer saw (see buildPrompt)
    SOURCES: sources.map((s) => ({ url: s.url, title: s.title, content: truncateText(s.content, 600) })),
    ANSWER: answer,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { output } = await generateText({
        model: JUDGE.model,
        system: JUDGE_PROMPT,
        prompt,
        output: Output.object({ schema: verdictSchema }),
        temperature: 0,
        maxOutputTokens: 2000,
        maxRetries: 0, // the eval runner owns rate-limit retries and pacing
        abortSignal: AbortSignal.timeout(90_000),
        // Extra reasoning makes claim-by-claim grading more careful (and offsets a Lite judge)
        providerOptions: JUDGE.provider === "groq"
          ? { groq: { reasoningEffort: "low" } }
          : { google: { thinkingConfig: { thinkingLevel: "medium" as const } } },
      });
      if (output.key_facts_covered.length !== testCase.key_facts.length) {
        throw new Error(`judge returned ${output.key_facts_covered.length} facts, expected ${testCase.key_facts.length}`);
      }
      output.claims_supported = Math.min(output.claims_supported, output.claims_total);
      return output;
    } catch (error) {
      // Rate limits go back to the runner's retry loop; only malformed verdicts are retried here
      if ((error as { statusCode?: number }).statusCode === 429) throw error;
      lastError = error;
    }
  }
  throw new Error(`Judge output invalid for ${testCase.id}: ${String(lastError)}`);
}
