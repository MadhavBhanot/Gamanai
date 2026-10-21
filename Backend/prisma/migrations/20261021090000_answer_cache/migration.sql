-- Semantic answer cache: a first-turn question whose embedding is near-identical (cosine >= threshold) to one
-- answered in the last 24 h replays the stored answer instead of searching and generating again.
CREATE TABLE "AnswerCache" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB NOT NULL,

    CONSTRAINT "AnswerCache_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnswerCache_createdAt_idx" ON "AnswerCache"("createdAt");
CREATE INDEX "AnswerCache_embedding_idx" ON "AnswerCache" USING hnsw ("embedding" vector_cosine_ops);

-- Same policy as every other public table: RLS on, no policies (the backend connects as the owner)
ALTER TABLE "AnswerCache" ENABLE ROW LEVEL SECURITY;
