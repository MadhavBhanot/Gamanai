import crypto from "node:crypto";
import { Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { GUEST_DAILY_LIMIT } from "../config";
import { prisma } from "../db";
import { authorize } from "../Middleware/authorize";
import { asyncHandler, getRequestUserId } from "../lib/http";
import { failSse, setSseHeaders, startSseKeepAlive, writeSseStatus } from "../lib/sse";
import { startRequestLog } from "../lib/requestLog";
import { slugify } from "../lib/text";
import { prepareAnswer } from "../llm/answer";
import { prepareDeepAnswer, type DeepPreparedAnswer } from "../llm/research";
import { streamAiResponse, type ChatMessage } from "../llm/stream";

// "deep" runs the research agent loop before answering; "quick" is the single-search pipeline
const answerMode = z.enum(["quick", "deep"]).default("quick");

const aiRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required"),
  mode: answerMode,
});

const followUpRequestSchema = aiRequestSchema.extend({
  conversationId: z.string().trim().min(1, "conversationId is required"),
});

const guestRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(500, "query is too long"),
  mode: answerMode,
});

/** Quick or deep preparation; deep streams each research step as a status event. */
function prepare(
  res: Response,
  conversationId: string,
  query: string,
  mode: "quick" | "deep",
  history: ChatMessage[] = [],
) {
  if (mode === "quick") return prepareAnswer(query, history);
  writeSseStatus(res, conversationId, "Planning research", "Breaking the question into searches.");
  return prepareDeepAnswer(query, history, {
    onStep: ({ index, tool, input, found }) =>
      writeSseStatus(
        res,
        conversationId,
        `Research step ${index}: ${tool === "extract_url" ? "read page" : "search"}`,
        `${input} (${found} new passage${found === 1 ? "" : "s"})`,
      ),
  });
}

const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: GUEST_DAILY_LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: `Guest demo is limited to ${GUEST_DAILY_LIMIT} questions per day. Sign in for more.` },
});

const stepCount = (prepared: Partial<DeepPreparedAnswer>) => prepared.steps?.length;

function sourceCountLabel(count: number, prefix = "") {
  return `${count} ${prefix}source${count === 1 ? "" : "s"} found.`;
}

export const aiRouter = Router();

aiRouter.post(
  "/",
  authorize,
  asyncHandler(async (req, res) => {
    const userId = getRequestUserId(req, res);
    if (!userId) return;

    const parsed = aiRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }

    const { query, mode } = parsed.data;

    const conversation = await prisma.conversation.create({
      data: {
        title: query.slice(0, 80),
        slug: slugify(query),
        userId,
        messages: {
          create: {
            content: query,
            role: "USER",
          },
        },
      },
    });

    // Start SSE immediately so the user sees status updates during search
    setSseHeaders(res, conversation.id);
    const stopKeepAlive = startSseKeepAlive(res);
    writeSseStatus(res, conversation.id, "Agent run started", "Searching the web for sources.");
    const log = startRequestLog({ route: "ai", mode, userId, conversationId: conversation.id });

    try {
      const prepared = await prepare(res, conversation.id, query, mode);
      const { results: webSearchResponse, messages, contexts } = prepared;

      writeSseStatus(res, conversation.id, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId: conversation.id,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepCount(prepared),
        onComplete: async (content) => {
          await prisma.message.create({
            data: {
              content,
              role: "ASSISTANT",
              conversationId: conversation.id,
            },
          });
        },
      });
    } catch (error) {
      console.error("AI stream preparation failed", error);
      log.finish({ ok: false, error: String((error as Error)?.message ?? error) });
      failSse(res, conversation.id, "Search or AI preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);

// Public demo: no auth, nothing persisted, rate limited per IP to protect free-tier quotas.
aiRouter.post(
  "/guest",
  guestLimiter,
  asyncHandler(async (req, res) => {
    const parsed = guestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }

    const { query, mode } = parsed.data;
    const conversationId = `guest-${crypto.randomUUID()}`;

    setSseHeaders(res, conversationId);
    const stopKeepAlive = startSseKeepAlive(res);
    writeSseStatus(res, conversationId, "Agent run started", "Searching the web for sources.");
    const log = startRequestLog({ route: "guest", mode });

    try {
      const prepared = await prepare(res, conversationId, query, mode);
      const { results: webSearchResponse, messages, contexts } = prepared;

      writeSseStatus(res, conversationId, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepCount(prepared),
      });
    } catch (error) {
      console.error("Guest stream preparation failed", error);
      log.finish({ ok: false, error: String((error as Error)?.message ?? error) });
      failSse(res, conversationId, "Search or AI preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);

aiRouter.post(
  "/follow_up",
  authorize,
  asyncHandler(async (req, res) => {
    const userId = getRequestUserId(req, res);
    if (!userId) return;

    const parsed = followUpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }

    const { conversationId, query, mode } = parsed.data;
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    setSseHeaders(res, conversationId);
    const stopKeepAlive = startSseKeepAlive(res);
    writeSseStatus(
      res,
      conversationId,
      "Follow-up accepted",
      "Preparing fresh context for the next answer.",
    );
    const log = startRequestLog({ route: "follow_up", mode, userId, conversationId });

    try {
      await prisma.message.create({
        data: {
          content: query,
          role: "USER",
          conversationId,
        },
      });

      writeSseStatus(
        res,
        conversationId,
        "Searching the web",
        "Extracting any referenced URLs and collecting fresh sources.",
      );
      const userQueries = conversation.messages
        .filter((message) => message.role === "USER")
        .slice(-5)
        .map((message, index) => `- Query ${index + 1}: ${message.content}`);

      const history: ChatMessage[] = userQueries.length
        ? [{
            role: "system",
            content: `\n\n## User Conversation History (Previous Queries):\n${userQueries.join("\n")}`,
          }]
        : [];

      const prepared = await prepare(res, conversationId, query, mode, history);
      const { results: webSearchResponse, messages, contexts } = prepared;
      writeSseStatus(res, conversationId, "Web search ready", sourceCountLabel(webSearchResponse.length, "fresh "));

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepCount(prepared),
        onComplete: async (content) => {
          await prisma.message.create({
            data: {
              content,
              role: "ASSISTANT",
              conversationId,
            },
          });
        },
      });
    } catch (error) {
      console.error("Follow-up stream preparation failed", error);
      log.finish({ ok: false, error: String((error as Error)?.message ?? error) });
      failSse(res, conversationId, "Follow-up preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);
