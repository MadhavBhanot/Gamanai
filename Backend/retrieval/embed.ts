import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { embedMany } from "ai";

export const EMBEDDING_DIMENSIONS = 768; // must match vector(768) in the SourceChunk migration
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "gemini-embedding-2";

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
const model = google.textEmbedding(EMBEDDING_MODEL);

/** Optional throttle (texts per minute). The eval runner sets one; live chat falls back to snippets on 429 instead. */
let limiter: { take(n: number): Promise<void> } | null = null;
export const setEmbeddingLimiter = (next: typeof limiter) => {
  limiter = next;
};

/** Gemini embeds documents and queries differently; using the matching task type improves recall. */
export async function embedTexts(values: string[], kind: "document" | "query") {
  if (!values.length) return [];
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
