import { prisma } from "../db";
import { EMBEDDING_MODEL, embedTexts, toVectorLiteral } from "./embed";

/**
 * Retrieval-first: before paying for a web search, look for the answer in passages already stored from earlier
 * searches. Only passages embedded with the current model and fetched in the last 30 days count.
 */
// Query-to-passage cosine depends on the embedding model. NVIDIA spot check: on-topic 0.6-0.7, adjacent 0.45-0.6,
// unrelated ~0.15. Gemini isn't measured yet, so it gets a stricter bar.
// shortcut: thresholds come from spot checks, not an eval; calibrate with an index-only eval run
export const INDEX_MIN_TOP_SCORE = Number(process.env.INDEX_FIRST_MIN_SCORE ?? (EMBEDDING_MODEL.startsWith("nvidia:") ? 0.6 : 0.8));
const INDEX_SUPPORT_SCORE = Number(process.env.INDEX_FIRST_SUPPORT_SCORE ?? INDEX_MIN_TOP_SCORE - 0.05);
const INDEX_MIN_SUPPORTING = 3;
const INDEX_MAX_AGE_DAYS = 30;
const INDEX_K = 8;

export type IndexChunk = { url: string; title: string; content: string; similarity: number };

export const indexFirstEnabled = () => process.env.INDEX_FIRST !== "off";

/** Nearest stored passages to the question, best first. Throws if embedding fails; callers fall back to the web. */
export async function searchIndex(query: string, k = INDEX_K) {
  const [embedding] = await embedTexts([query], "query");
  const vector = toVectorLiteral(embedding);
  return prisma.$queryRaw<IndexChunk[]>`
    SELECT url, title, content, 1 - ("embedding" <=> ${vector}::vector) AS similarity
    FROM "SourceChunk"
    WHERE "embedding" IS NOT NULL AND "embeddingModel" = ${EMBEDDING_MODEL}
      AND "createdAt" > NOW() - make_interval(days => ${INDEX_MAX_AGE_DAYS})
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${k}`;
}

/** Confident = a strong best match and enough supporting passages that one lucky chunk can't carry an answer. */
export function isIndexConfident(chunks: IndexChunk[]) {
  return (
    (chunks[0]?.similarity ?? 0) >= INDEX_MIN_TOP_SCORE &&
    chunks.filter((c) => c.similarity >= INDEX_SUPPORT_SCORE).length >= INDEX_MIN_SUPPORTING
  );
}
