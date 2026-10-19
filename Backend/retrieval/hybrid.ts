import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { chunkText, cleanPageText, hashContent } from "./chunk";
import { embedTexts, toVectorLiteral } from "./embed";

export type RetrievalMode = "hybrid" | "vector" | "fts";
export type RetrievedChunk = { url: string; title: string; content: string; score: number };

const RRF_K = 60; // standard reciprocal-rank-fusion damping constant
const CANDIDATES_PER_RANKER = 40;

const STOPWORDS = new Set(
  "the and for are was were what which who whom whose when where why how does did this that these those with from into about than then there their they them can could should would will its it's has have had not but you your our per via".split(" "),
);

/** websearch_to_tsquery ANDs words; OR them instead so natural-language questions still match. */
export function toOrQuery(query: string) {
  const words = query.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !w.startsWith("http")))].join(" or ");
}

/** Chunk + embed pages we haven't stored yet. Returns how many new chunks were embedded. */
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

  // Title prefix gives short chunks context ("Okapi BM25 - Wikipedia\n...")
  const embeddings = await embedTexts(fresh.map((r) => `${r.title}\n${r.content}`), "document");
  await prisma.$executeRaw`
    INSERT INTO "SourceChunk" ("url", "title", "chunkIndex", "contentHash", "content", "embedding")
    VALUES ${Prisma.join(
      fresh.map(
        (r, i) =>
          Prisma.sql`(${r.url}, ${r.title}, ${r.chunkIndex}, ${r.contentHash}, ${r.content}, ${toVectorLiteral(embeddings[i])}::vector)`,
      ),
    )}
    ON CONFLICT ("url", "contentHash") DO NOTHING`;
  return fresh.length;
}

/**
 * Top-k chunks from the given pages: cosine-similarity ranking and Postgres full-text ranking,
 * merged with reciprocal rank fusion. `mode` zeroes one ranker's weight for ablations.
 */
// ponytail: scans only this question's pages (~200 rows), so no ANN index; add HNSW when searching all stored chunks.
export async function retrieveChunks(query: string, urls: string[], { k = 8, mode = "hybrid" as RetrievalMode } = {}) {
  if (!urls.length) return [];
  const [queryEmbedding] = await embedTexts([query], "query");
  const vector = toVectorLiteral(queryEmbedding);
  const vectorWeight = mode === "fts" ? 0 : 1;
  const textWeight = mode === "vector" ? 0 : 1;

  return prisma.$queryRaw<RetrievedChunk[]>`
    WITH c AS (
      SELECT id, url, title, content, embedding,
             to_tsvector('english', title || ' ' || content) AS tsv
      FROM "SourceChunk" WHERE url = ANY(${urls})
    ),
    v AS (
      SELECT id, row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS r
      FROM c ORDER BY embedding <=> ${vector}::vector LIMIT ${CANDIDATES_PER_RANKER}
    ),
    f AS (
      SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) AS r
      FROM c, websearch_to_tsquery('english', ${toOrQuery(query)}) q
      WHERE tsv @@ q ORDER BY ts_rank_cd(tsv, q) DESC LIMIT ${CANDIDATES_PER_RANKER}
    )
    SELECT c.url, c.title, c.content,
           (COALESCE(${vectorWeight}::float8 / (${RRF_K} + v.r), 0)
          + COALESCE(${textWeight}::float8 / (${RRF_K} + f.r), 0))::float8 AS score
    FROM c LEFT JOIN v ON v.id = c.id LEFT JOIN f ON f.id = c.id
    WHERE v.r IS NOT NULL OR f.r IS NOT NULL
    ORDER BY score DESC, c.id
    LIMIT ${k}`;
}
