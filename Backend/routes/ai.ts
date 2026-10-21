import crypto from "node:crypto";
import { Router, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { GUEST_DAILY_LIMIT } from "../config";
import { prisma } from "../db";
import { authorize } from "../Middleware/authorize";
import { asyncHandler, getRequestUserId } from "../lib/http";
import { abortOnClose, failSse, setSseHeaders, startSseKeepAlive, writeSseStatus } from "../lib/sse";
import { startRequestLog } from "../lib/requestLog";
import { traceRequest } from "../lib/tracing";
import { slugify } from "../lib/text";
import { answerFromIndex, prepareAnswer } from "../llm/answer";
import { describeStep, prepareDeepAnswer, type DeepPreparedAnswer } from "../llm/research";
import { lookupCachedAnswer, storeCachedAnswer } from "../llm/cache";
import { standaloneQuery } from "../llm/contextualize";
import { replayCachedAnswer, streamAiResponse, type ChatMessage } from "../llm/stream";

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
  // Guests have nothing saved server-side, so the client sends the recent turns for follow-up questions
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(8)
    .default([]),
});

/** Quick or deep preparation; deep streams each research step as a status event. */
async function prepare(
  res: Response,
  conversationId: string,
  query: string,
  mode: "quick" | "deep",
  history: ChatMessage[] = [],
  signal?: AbortSignal,
) {
  if (mode === "quick") {
    // Passages saved from earlier searches first; the web only when they don't clearly cover the question
    const fromIndex = await answerFromIndex(query, history);
    if (fromIndex) {
      writeSseStatus(res, conversationId, "Found in saved sources", `${fromIndex.contexts.length} stored passages match; skipping web search.`);
      return fromIndex;
    }
    return prepareAnswer(query, history);
  }
  writeSseStatus(res, conversationId, "Planning research", "Breaking the question into searches.");
  return prepareDeepAnswer(query, history, {
    signal,
    onStep: (step) => {
      const { label, detail } = describeStep(step, step.index);
      writeSseStatus(res, conversationId, label, detail);
    },
  });
}

const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: GUEST_DAILY_LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: `Guest demo is limited to ${GUEST_DAILY_LIMIT} questions per day. Sign in for more.` },
});

const stepsOf = (prepared: object) => ("steps" in prepared ? (prepared as DeepPreparedAnswer).steps : undefined);

function sourceCountLabel(count: number, prefix = "") {
  return `${count} ${prefix}source${count === 1 ? "" : "s"} found.`;
}

export const aiRouter = Router();

aiRouter.post(
  "/",
  authorize,
  traceRequest("ai"),
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
    const signal = abortOnClose(res);
    writeSseStatus(res, conversation.id, "Agent run started", "Looking for sources.");
    const log = startRequestLog({ route: "ai", mode, userId, conversationId: conversation.id });

    try {
      const cache = await lookupCachedAnswer(query, mode);
      if (cache.hit) {
        await prisma.message.create({ data: { content: cache.hit.content, role: "ASSISTANT", conversationId: conversation.id } });
        replayCachedAnswer(res, conversation.id, cache.hit, log);
        return;
      }

      const prepared = await prepare(res, conversation.id, query, mode, [], signal);
      const { results: webSearchResponse, messages, contexts } = prepared;
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }

      if (prepared.contextMode !== "index") writeSseStatus(res, conversation.id, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId: conversation.id,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepsOf(prepared),
        signal,
        onComplete: async (content) => {
          await prisma.message.create({
            data: {
              content,
              role: "ASSISTANT",
              conversationId: conversation.id,
            },
          });
          if (cache.embedding) void storeCachedAnswer(query, mode, cache.embedding, content, webSearchResponse);
        },
      });
    } catch (error) {
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }
      console.error("AI stream preparation failed", error);
      log.finish({ ok: false, error: String((error as Error)?.message ?? error) });
      failSse(res, conversation.id, "Search or AI preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);

// Public demo: no auth, no conversation saved (answers feed the shared cache), rate limited per IP for free-tier quotas.
aiRouter.post(
  "/guest",
  guestLimiter,
  traceRequest("guest"),
  asyncHandler(async (req, res) => {
    const parsed = guestRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }

    const { query: asked, mode, history } = parsed.data;
    const conversationId = `guest-${crypto.randomUUID()}`;

    setSseHeaders(res, conversationId);
    const stopKeepAlive = startSseKeepAlive(res);
    const signal = abortOnClose(res);
    writeSseStatus(res, conversationId, "Agent run started", "Looking for sources.");
    const log = startRequestLog({ route: "guest", mode });

    try {
      const query = await standaloneQuery(asked, history, { signal });
      if (query !== asked) writeSseStatus(res, conversationId, "Understood as", query);
      // Keyed on the resolved question, so "what was their lineup?" can't replay another chat's answer
      const cache = await lookupCachedAnswer(query, mode);
      if (cache.hit) {
        replayCachedAnswer(res, conversationId, cache.hit, log);
        return;
      }

      const prepared = await prepare(res, conversationId, query, mode, [], signal);
      const { results: webSearchResponse, messages, contexts } = prepared;
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }

      if (prepared.contextMode !== "index") writeSseStatus(res, conversationId, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepsOf(prepared),
        signal,
        // Only the answer and its sources are stored (no user or IP), to serve the next identical question
        onComplete: async (content) => {
          if (cache.embedding) void storeCachedAnswer(query, mode, cache.embedding, content, webSearchResponse);
        },
      });
    } catch (error) {
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }
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
  traceRequest("follow_up"),
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
    const signal = abortOnClose(res);
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
      const turns = conversation.messages.map((m) => ({ role: m.role === "USER" ? ("user" as const) : ("assistant" as const), content: m.content }));
      const searchQuery = await standaloneQuery(query, turns, { signal });
      if (searchQuery !== query) writeSseStatus(res, conversationId, "Understood as", searchQuery);

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

      const prepared = await prepare(res, conversationId, searchQuery, mode, history, signal);
      const { results: webSearchResponse, messages, contexts } = prepared;
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }
      if (prepared.contextMode !== "index") writeSseStatus(res, conversationId, "Web search ready", sourceCountLabel(webSearchResponse.length, "fresh "));

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages,
        contexts,
        log,
        researchSteps: stepsOf(prepared),
        signal,
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
      if (signal.aborted) {
        log.finish({ ok: false, error: "stopped by client" });
        return;
      }
      console.error("Follow-up stream preparation failed", error);
      log.finish({ ok: false, error: String((error as Error)?.message ?? error) });
      failSse(res, conversationId, "Follow-up preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);
