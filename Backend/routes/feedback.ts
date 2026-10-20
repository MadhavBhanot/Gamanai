import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../db";
import { asyncHandler } from "../lib/http";

// Guests can rate answers too, so this is public; the limiter and size caps keep it from being a free text dump.
const feedbackSchema = z.object({
  rating: z.union([z.literal(1), z.literal(-1)]),
  query: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(20000),
  conversationId: z.string().trim().max(100).optional(),
  mode: z.enum(["quick", "deep"]).optional(),
  comment: z.string().trim().max(1000).optional(),
});

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too much feedback from this address; try again later." },
});

export const feedbackRouter = Router();

feedbackRouter.post(
  "/",
  feedbackLimiter,
  asyncHandler(async (req, res) => {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }
    const row = await prisma.feedback.create({ data: parsed.data });
    res.status(201).json({ id: String(row.id) });
  }),
);
