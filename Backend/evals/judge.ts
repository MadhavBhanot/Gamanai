import Groq from "groq-sdk";
import { z } from "zod";
import { truncateText } from "../lib/text";
import type { WebSearchResult } from "../retrieval/search";
import type { EvalCase } from "./metrics";

// Different model family from the answerer (Qwen) to reduce self-preference bias.
export const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "openai/gpt-oss-120b";

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
  client: Groq,
  testCase: EvalCase,
  sources: WebSearchResult[],
  answer: string,
): Promise<Verdict> {
  const userContent = JSON.stringify({
    QUESTION: testCase.query,
    FALSE_PREMISE: testCase.should_refuse,
    REFERENCE_KEY_FACTS: testCase.key_facts,
    // Same snippet budget the answerer saw (see buildPrompt)
    SOURCES: sources.map((s) => ({ url: s.url, title: s.title, content: truncateText(s.content, 600) })),
    ANSWER: answer,
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await client.chat.completions.create({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      temperature: 0,
      max_completion_tokens: 2000,
    });

    try {
      const verdict = verdictSchema.parse(JSON.parse(completion.choices[0]?.message?.content ?? ""));
      if (verdict.key_facts_covered.length !== testCase.key_facts.length) {
        throw new Error(`judge returned ${verdict.key_facts_covered.length} facts, expected ${testCase.key_facts.length}`);
      }
      verdict.claims_supported = Math.min(verdict.claims_supported, verdict.claims_total);
      return verdict;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Judge output invalid for ${testCase.id}: ${String(lastError)}`);
}
