-- Two-stage retrieval: chunks are stored at index time without vectors; only full-text
-- candidates get embedded, lazily. Tag each vector with its model so a model change
-- never mixes incompatible vector spaces (stale vectors are simply re-embedded).
ALTER TABLE "SourceChunk" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "SourceChunk" ADD COLUMN "embeddingModel" TEXT;
UPDATE "SourceChunk" SET "embeddingModel" = 'gemini-embedding-2' WHERE "embedding" IS NOT NULL;
