import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany } from "ai";

export const EMBEDDING_DIMENSIONS = 768; // must match vector(768) in the SourceChunk migration
// Gemini free tier: 1,000 texts/day. "nvidia:<model>" uses NVIDIA's catalog instead (limited per request, not per
// text). Vectors are tagged with this name, so changing it is safe (old vectors are ignored and re-embedded on demand).
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
const model = google.textEmbedding(EMBEDDING_MODEL);
const NVIDIA_BATCH = 50;

async function embedWithNvidia(modelId: string, values: string[], kind: "document" | "query") {
  const embeddings: number[][] = [];
  for (let i = 0; i < values.length; i += NVIDIA_BATCH) {
    const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        input: values.slice(i, i + NVIDIA_BATCH),
        input_type: kind === "document" ? "passage" : "query",
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`NVIDIA embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const { data } = (await response.json()) as { data: { index: number; embedding: number[] }[] };
    embeddings.push(...data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return embeddings;
}

/** Optional throttle (texts per minute). The eval runner sets one; live chat falls back to snippets on 429 instead. */
let limiter: { take(n: number): Promise<void> } | null = null;
export const setEmbeddingLimiter = (next: typeof limiter) => {
  limiter = next;
};

/** Gemini embeds documents and queries differently; using the matching task type improves recall. */
export async function embedTexts(values: string[], kind: "document" | "query") {
  if (!values.length) return [];
  if (EMBEDDING_MODEL.startsWith("nvidia:")) return embedWithNvidia(EMBEDDING_MODEL.slice("nvidia:".length), values, kind);
  await limiter?.take(values.length); // free tier counts every text as one request
  const { embeddings } = await embedMany({
    model,
    values,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(20_000),
    providerOptions: {
      google: {
        outputDimensionality: EMBEDDING_DIMENSIONS,
        taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
      },
    },
  });
  return embeddings;
}

/** pgvector text literal, e.g. "[0.1,0.2,...]" */
export const toVectorLiteral = (embedding: number[]) => `[${embedding.join(",")}]`;
