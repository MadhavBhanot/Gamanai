// Cross-encoder reranking via Jina (free key: 100 RPM / 100k tokens per minute).
const RERANK_MODEL = process.env.RERANK_MODEL ?? "jina-reranker-v3.5";

/** Indices of `documents`, best first, cut to `topN`. Throws on API errors so retrieval can fall back. */
export async function rerankDocuments(query: string, documents: string[], topN: number) {
  if (!documents.length) return [];
  if (!process.env.JINA_API_KEY) throw new Error("JINA_API_KEY is not set");
  const response = await fetch("https://api.jina.ai/v1/rerank", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.JINA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_n: topN, return_documents: false }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Jina rerank ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const { results } = (await response.json()) as { results: { index: number; relevance_score: number }[] };
  return results.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, topN).map((r) => r.index);
}
