-- CreateTable
CREATE TABLE "RequestLog" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "route" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "model" TEXT,
    "fellBack" BOOLEAN NOT NULL DEFAULT false,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "totalMs" INTEGER NOT NULL,
    "ttftMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "researchSteps" INTEGER,
    "sourceCount" INTEGER,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rating" INTEGER NOT NULL,
    "userId" TEXT,
    "conversationId" TEXT,
    "mode" TEXT,
    "query" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "comment" TEXT,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestLog_createdAt_idx" ON "RequestLog"("createdAt");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

-- Same deny-all stance as 20261019100000_enable_rls: hidden from Supabase's REST roles, the backend owner bypasses RLS
ALTER TABLE "RequestLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Feedback" ENABLE ROW LEVEL SECURITY;
