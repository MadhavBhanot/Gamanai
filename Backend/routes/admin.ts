import { Router, type NextFunction, type Request, type Response } from "express";
import { prisma } from "../db";
import { authorize } from "../Middleware/authorize";
import { asyncHandler } from "../lib/http";

// ADMIN_EMAILS: comma-separated emails allowed to see the ops dashboard (checked against Supabase's verified email)
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.userEmail || !adminEmails.has(req.userEmail.toLowerCase())) {
    res.status(403).json({ error: "Admins only" });
    return;
  }
  next();
}

type DayRow = {
  day: Date;
  requests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  avgTokens: number | null;
  errors: number;
  fallbacks: number;
  cacheHits: number;
  deep: number;
};

export const adminRouter = Router();

adminRouter.get(
  "/stats",
  authorize,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const [days, feedback, ratings] = await Promise.all([
      prisma.$queryRaw<DayRow[]>`
        SELECT date_trunc('day', "createdAt") AS day,
               count(*)::int AS requests,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY "totalMs"))::int AS "p50Ms",
               (percentile_cont(0.95) WITHIN GROUP (ORDER BY "totalMs"))::int AS "p95Ms",
               avg(coalesce("promptTokens", 0) + coalesce("completionTokens", 0))::int AS "avgTokens",
               count(*) FILTER (WHERE NOT ok)::int AS errors,
               count(*) FILTER (WHERE "fellBack")::int AS fallbacks,
               count(*) FILTER (WHERE model = 'cache')::int AS "cacheHits",
               count(*) FILTER (WHERE mode = 'deep')::int AS deep
        FROM "RequestLog"
        WHERE "createdAt" > now() - interval '14 days'
        GROUP BY 1
        ORDER BY 1`,
      prisma.feedback.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.feedback.groupBy({ by: ["rating"], _count: true }),
    ]);

    res.json({
      days,
      // BigInt ids don't survive JSON.stringify
      feedback: feedback.map((f) => ({ ...f, id: String(f.id) })),
      ratings: Object.fromEntries(ratings.map((r) => [r.rating === 1 ? "up" : "down", r._count])),
    });
  }),
);
