import { prisma } from "../db";
import { EMBEDDING_MODEL, embedTexts, toVectorLiteral } from "../retrieval/embed";
import type { WebSearchResult } from "../retrieval/search";

// shortcut: 0.95 is the roadmap's starting guess, not yet calibrated on paraphrase pairs; tune with an eval
const CACHE_MIN_SIMILARITY = Number(process.env.CACHE_MIN_SIMILARITY ?? 0.95);
const CACHE_MAX_AGE_HOURS = 24;

// Questions about now/latest go to the web every time: a day-old answer can be wrong
const TIME_SENSITIVE =
  /\b(latest|newest|recent(ly)?|current(ly)?|today|tonight|yesterday|tomorrow|now|this (week|month|year)|right now|live|breaking|price|prices|stock|score|scores|weather|forecast|news|update[sd]?)\b/i;

export const isCacheable = (query: string) => !TIME_SENSITIVE.test(query) && !/https?:\/\//i.test(query);

export type CachedAnswer = { content: string; sources: WebSearchResult[]; similarity: number };

/**
 * Embed the question and look for a near-identical one answered recently in the same mode.
 * Returns the embedding too, so a miss can store the new answer without embedding twice.
 * Never throws: a cache problem must not block an answer.
 */
export async function lookupCachedAnswer(query: string, mode: "quick" | "deep") {
  if (!isCacheable(query)) return { hit: null, embedding: null };
  try {
    const [embedding] = await embedTexts([query], "query");
    const [row] = await prisma.$queryRaw<Array<{ content: string; sources: WebSearchResult[]; similarity: number }>>`
      SELECT "content", "sources", 1 - ("embedding" <=> ${toVectorLiteral(embedding)}::vector) AS similarity
      FROM "AnswerCache"
      WHERE "mode" = ${mode} AND "embeddingModel" = ${EMBEDDING_MODEL}
        AND "createdAt" > NOW() - make_interval(hours => ${CACHE_MAX_AGE_HOURS})
      ORDER BY "embedding" <=> ${toVectorLiteral(embedding)}::vector
      LIMIT 1`;
    const hit: CachedAnswer | null = row && row.similarity >= CACHE_MIN_SIMILARITY ? row : null;
    return { hit, embedding };
  } catch (error) {
    console.warn(`[cache] lookup skipped: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return { hit: null, embedding: null };
  }
}

export async function storeCachedAnswer(
  query: string,
  mode: "quick" | "deep",
  embedding: number[],
  content: string,
  sources: WebSearchResult[],
) {
  try {
    // Page text is for retrieval only; the replay needs what the UI shows
    const shown = sources.map(({ rawContent: _raw, ...source }) => source);
    await prisma.$executeRaw`
      INSERT INTO "AnswerCache" ("query", "mode", "embedding", "embeddingModel", "content", "sources")
      VALUES (${query}, ${mode}, ${toVectorLiteral(embedding)}::vector, ${EMBEDDING_MODEL}, ${content}, ${JSON.stringify(shown)}::jsonb)`;
  } catch (error) {
    console.warn(`[cache] store failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`);
  }
}
