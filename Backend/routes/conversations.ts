import { Router } from "express";
import { authorize } from "../Middleware/authorize";
import { prisma } from "../db";
import { asyncHandler, getRequestUserId, getRouteParam } from "../lib/http";

const messageSelect = {
  id: true,
  content: true,
  role: true,
  createdAt: true,
} as const;

const conversationDetailSelect = {
  id: true,
  title: true,
  slug: true,
  messages: {
    orderBy: { createdAt: "asc" },
    select: messageSelect,
  },
} as const;

export const conversationsRouter = Router();

conversationsRouter.get(
  "/",
  authorize,
  asyncHandler(async (req, res) => {
    const userId = getRequestUserId(req, res);
    if (!userId) return;

    const conversations = await prisma.conversation.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        slug: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            content: true,
            role: true,
            createdAt: true,
          },
        },
      },
    });

    const normalizedConversations = conversations
      .map((conversation) => {
        const lastMessage = conversation.messages[0];

        return {
          id: conversation.id,
          title: conversation.title,
          slug: conversation.slug,
          lastMessage: lastMessage?.content ?? "",
          lastMessageRole: lastMessage?.role ?? "",
          updatedAt: lastMessage?.createdAt.toISOString() ?? "",
        };
      })
      .sort((left, right) => {
        const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
        const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
        return rightTime - leftTime;
      });

    res.json({ userId, conversations: normalizedConversations });
  }),
);

const getConversationHandler = asyncHandler(async (req, res) => {
  const userId = getRequestUserId(req, res);
  if (!userId) return;

  const conversationId = getRouteParam(req.params.id);
  if (!conversationId) {
    res.status(400).json({ error: "Invalid conversation ID" });
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: conversationDetailSelect,
  });

  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.json(conversation);
});

conversationsRouter.get("/:id", authorize, getConversationHandler);
conversationsRouter.post("/:id", authorize, getConversationHandler);

conversationsRouter.delete(
  "/:id",
  authorize,
  asyncHandler(async (req, res) => {
    const userId = getRequestUserId(req, res);
    if (!userId) return;

    const conversationId = getRouteParam(req.params.id);
    if (!conversationId) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    await prisma.message.deleteMany({
      where: { conversationId },
    });
    await prisma.conversation.delete({
      where: { id: conversationId },
    });

    res.status(204).end();
  }),
);
