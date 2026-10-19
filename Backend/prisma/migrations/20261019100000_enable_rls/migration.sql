-- Lock the public schema out of Supabase's REST API (PostgREST roles anon/authenticated).
-- No policies on purpose: the backend connects as the table owner (postgres), which RLS doesn't apply to,
-- so the app is unaffected while the public frontend key can no longer read or write these tables.
ALTER TABLE "USER" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
