import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { GUEST_DAILY_LIMIT } from "../config";
import { prisma } from "../db";
import { authorize } from "../Middleware/authorize";
import { asyncHandler, getRequestUserId } from "../lib/http";
import { failSse, setSseHeaders, startSseKeepAlive, writeSseStatus } from "../lib/sse";
import { slugify } from "../lib/text";
import { buildPrompt } from "../llm/buildPrompt";
import { streamAiResponse, type ChatMessage } from "../llm/stream";
import { SYSTEM_PROMPT } from "../prompt";
import { getWebSearchResults } from "../retrieval/search";

const aiRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required"),
});

const followUpRequestSchema = aiRequestSchema.extend({
  conversationId: z.string().trim().min(1, "conversationId is required"),
});

const guestRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(500, "query is too long"),
});

const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: GUEST_DAILY_LIMIT,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: `Guest demo is limited to ${GUEST_DAILY_LIMIT} questions per day. Sign in for more.` },
});

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

    const { query } = parsed.data;

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

    try {
      const { queryContext, results: webSearchResponse, images } =
        await getWebSearchResults(query);

      writeSseStatus(res, conversation.id, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId: conversation.id,
        webSearchResponse,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(queryContext, webSearchResponse, images) },
        ],
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

    const { query } = parsed.data;
    const conversationId = `guest-${crypto.randomUUID()}`;

    setSseHeaders(res, conversationId);
    const stopKeepAlive = startSseKeepAlive(res);
    writeSseStatus(res, conversationId, "Agent run started", "Searching the web for sources.");

    try {
      const { queryContext, results: webSearchResponse, images } =
        await getWebSearchResults(query);

      writeSseStatus(res, conversationId, "Web search complete", sourceCountLabel(webSearchResponse.length));

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(queryContext, webSearchResponse, images) },
        ],
      });
    } catch (error) {
      console.error("Guest stream preparation failed", error);
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

    const { conversationId, query } = parsed.data;
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
      const { queryContext, results: webSearchResponse, images } =
        await getWebSearchResults(query);
      writeSseStatus(res, conversationId, "Web search ready", sourceCountLabel(webSearchResponse.length, "fresh "));

      const userQueries = conversation.messages
        .filter((message) => message.role === "USER")
        .slice(-5)
        .map((message, index) => `- Query ${index + 1}: ${message.content}`);

      const llmMessages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

      if (userQueries.length > 0) {
        llmMessages.push({
          role: "system",
          content: `\n\n## User Conversation History (Previous Queries):\n${userQueries.join("\n")}`,
        });
      }

      llmMessages.push({
        role: "user",
        content: buildPrompt(queryContext, webSearchResponse, images),
      });

      await streamAiResponse({
        res,
        conversationId,
        webSearchResponse,
        messages: llmMessages,
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
      failSse(res, conversationId, "Follow-up preparation failed");
    } finally {
      stopKeepAlive();
    }
  }),
);
