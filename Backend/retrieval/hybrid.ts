import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { chunkText, cleanPageText, hashContent } from "./chunk";
import { EMBEDDING_MODEL, embedTexts, toVectorLiteral } from "./embed";
import { stripUrlsFromQuery } from "./query";

/**
 * Two-stage retrieval, sized for Gemini's free embedding tier (1,000 texts/day):
 *   1. recall: Postgres full-text search over every stored chunk of this question's pages (free)
 *   2. rerank: embed only the recalled candidates (cached per chunk), rank by cosine similarity,
 *      and fuse the full-text and vector orders with reciprocal rank fusion.
 * Modes for ablations: "fts" skips stage 2; "vector" reranks by similarity alone; "hybrid" fuses both.
 */
export type RetrievalMode = "hybrid" | "vector" | "fts";
export type RetrievedChunk = { url: string; title: string; content: string; score: number };

const RRF_K = 60; // standard reciprocal-rank-fusion damping constant
const RECALL_CANDIDATES = 12; // => at most 12 document + 1 query embeddings per question

const STOPWORDS = new Set(
  "the and for are was were what which who whom whose when where why how does did this that these those with from into about than then there their they them can could should would will its it's has have had not but you your our per via".split(" "),
);

/** websearch_to_tsquery ANDs words; OR them instead so natural-language questions still match. */
export function toOrQuery(query: string) {
  const words = stripUrlsFromQuery(query).toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/[.+#-]+$/, "")).filter((w) => w.length > 2 && !STOPWORDS.has(w)))].join(" or ");
}

/** Reciprocal rank fusion: each ranking contributes weight / (k + position); unranked items contribute 0. */
export function fuseRankings<T>(rankings: Array<{ order: T[]; weight: number }>, k = RRF_K) {
  const scores = new Map<T, number>();
  for (const { order, weight } of rankings) {
    order.forEach((item, index) => scores.set(item, (scores.get(item) ?? 0) + weight / (k + index + 1)));
  }
  return scores;
}

/** Store chunks of pages we haven't seen. No embedding here: that happens lazily, for candidates only. */
export async function indexPages(pages: Array<{ url: string; title: string; text: string }>) {
  const rows = pages.flatMap((page) =>
    chunkText(cleanPageText(page.text)).map((content, chunkIndex) => ({
      url: page.url,
      title: page.title.slice(0, 300),
      chunkIndex,
      content,
      contentHash: hashContent(content),
    })),
  );
  if (!rows.length) return 0;

  const existing = await prisma.sourceChunk.findMany({
    where: { url: { in: [...new Set(rows.map((r) => r.url))] } },
    select: { url: true, contentHash: true },
  });
  const seen = new Set(existing.map((e) => `${e.url}\0${e.contentHash}`));
  const fresh = rows.filter((r) => {
    const key = `${r.url}\0${r.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!fresh.length) return 0;

  await prisma.$executeRaw`
    INSERT INTO "SourceChunk" ("url", "title", "chunkIndex", "contentHash", "content")
    VALUES ${Prisma.join(fresh.map((r) => Prisma.sql`(${r.url}, ${r.title}, ${r.chunkIndex}, ${r.contentHash}, ${r.content})`))}
    ON CONFLICT ("url", "contentHash") DO NOTHING`;
  return fresh.length;
}

type Candidate = { id: bigint; url: string; title: string; content: string; embedded: boolean; ftsRanked: boolean };

/** Stage 1: full-text top-N, topped up with each page's opening chunk when few keywords match. */
async function recall(query: string, urls: string[]) {
  return prisma.$queryRaw<Candidate[]>`
    WITH c AS (
      SELECT id, url, title, content, "chunkIndex",
             ("embedding" IS NOT NULL AND "embeddingModel" = ${EMBEDDING_MODEL}) AS embedded,
             to_tsvector('english', title || ' ' || content) AS tsv
      FROM "SourceChunk" WHERE url = ANY(${urls})
    ),
    f AS (
      SELECT id, ts_rank_cd(tsv, q) AS rank
      FROM c, websearch_to_tsquery('english', ${toOrQuery(query)}) q
      WHERE tsv @@ q ORDER BY rank DESC LIMIT ${RECALL_CANDIDATES}
    )
    SELECT c.id, c.url, c.title, c.content, c.embedded, (f.id IS NOT NULL) AS "ftsRanked"
    FROM c LEFT JOIN f ON f.id = c.id
    WHERE f.id IS NOT NULL OR c."chunkIndex" = 0
    ORDER BY f.rank DESC NULLS LAST, c.id
    LIMIT ${RECALL_CANDIDATES}`;
}

/** Stage 2 helper: embed candidates that have no vector for the current model, and store them. */
async function ensureEmbeddings(candidates: Candidate[]) {
  const missing = candidates.filter((c) => !c.embedded);
  if (!missing.length) return;
  const embeddings = await embedTexts(missing.map((c) => `${c.title}\n${c.content}`), "document");
  await prisma.$executeRaw`
    UPDATE "SourceChunk" AS s
    SET "embedding" = v.e::vector, "embeddingModel" = ${EMBEDDING_MODEL}
    FROM (VALUES ${Prisma.join(missing.map((c, i) => Prisma.sql`(${c.id}::bigint, ${toVectorLiteral(embeddings[i])})`))}) AS v(id, e)
    WHERE s.id = v.id`;
}

export async function retrieveChunks(query: string, urls: string[], { k = 8, mode = "hybrid" as RetrievalMode } = {}) {
  if (!urls.length) return [];
  const candidates = await recall(query, urls);
  if (!candidates.length) return [];

  const ftsOrder = candidates.filter((c) => c.ftsRanked).map((c) => c.id);
  let vectorOrder: bigint[] = [];

  if (mode !== "fts") {
    await ensureEmbeddings(candidates);
    const [queryEmbedding] = await embedTexts([query], "query");
    const ids = candidates.map((c) => c.id);
    const ranked = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM "SourceChunk" WHERE id = ANY(${ids}::bigint[])
      ORDER BY "embedding" <=> ${toVectorLiteral(queryEmbedding)}::vector`;
    vectorOrder = ranked.map((r) => r.id);
  }

  // fts mode keeps recall order (keyword matches first, then page openings)
  const scores =
    mode === "fts"
      ? fuseRankings([{ order: candidates.map((c) => c.id), weight: 1 }])
      : fuseRankings([
          { order: vectorOrder, weight: 1 },
          { order: ftsOrder, weight: mode === "vector" ? 0 : 1 },
        ]);

  return candidates
    .map((c) => ({ url: c.url, title: c.title, content: c.content, score: scores.get(c.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
