-- pgvector lives in Supabase's "extensions" schema (on the default search_path)
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- CreateTable
CREATE TABLE "SourceChunk" (
    "id" BIGSERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceChunk_url_contentHash_key" ON "SourceChunk"("url", "contentHash");

-- CreateIndex
CREATE INDEX "SourceChunk_url_idx" ON "SourceChunk"("url");
