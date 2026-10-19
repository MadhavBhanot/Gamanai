import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import { tavily } from "@tavily/core";
import Groq from "groq-sdk";
import { z } from "zod";
import { PROMPT_TEMPLATE, SYSTEM_PROMPT, CONTEXT_SUMMARY_PROMPT, FOLLOW_UP_SYSTEM_PROMPT } from "./prompt";
import { authorize } from "./Middleware/authorize";
import { prisma } from "./db";

const app = express();
const port = Number(process.env.PORT ?? 8000);

const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const tavly = tavily({
  apiKey: process.env.TAVILY_API_KEY ?? "",
});

const groq = new Groq({
  apiKey: process.env.Groq_API_Key ?? "",
});

const aiRequestSchema = z.object({
  query: z.string().trim().min(1, "query is required"),
});

const followUpRequestSchema = aiRequestSchema.extend({
  conversationId: z.string().trim().min(1, "conversationId is required"),
});

type AsyncRoute = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => Promise<void>;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type QueryOptimizationContext = {
  originalQuery: string;
  queryWithoutUrls: string;
  referencedUrls: string[];
  referencedDomains: string[];
  optimizedSearchQuery: string;
  llmFocusBlock: string;
};

type WebSearchResult = {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score?: number;
  publishedDate?: string;
  favicon?: string;
  images?: string[];
  sourceType: "search" | "direct_url_extract";
  focusedByUser?: boolean;
};

type ImageCandidate = {
  url: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDomain: string;
  sourceType: "search" | "direct_url_extract";
  focusedByUser?: boolean;
};

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

/** Max number of raw messages before we switch to summary mode */
const HISTORY_COMPRESSION_THRESHOLD = 10;
const SUMMARY_RECENT_MESSAGE_LIMIT = 10;
const SUMMARY_MESSAGE_CHAR_LIMIT = 320;
const SUMMARY_USER_QUERY_CHAR_LIMIT = 180;
const SSE_KEEPALIVE_INTERVAL_MS = 10_000;
const DIRECT_EXTRACT_CONTENT_CHAR_LIMIT = 6_000;
const DIRECT_EXTRACT_SNIPPET_CHAR_LIMIT = 1_200;
const URL_MATCH_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

function asyncHandler(handler: AsyncRoute): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function getRequestUserId(req: express.Request, res: express.Response) {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  return req.userId;
}

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function slugify(text: string) {
  const base =
    text
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "chat";

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.startsWith("http")))];
}

function trimTrailingUrlPunctuation(value: string) {
  return value.replace(/[),.;!?]+$/g, "");
}

function normalizeUrl(value: string) {
  const candidate = trimTrailingUrlPunctuation(value.trim());

  try {
    const parsed = new URL(candidate);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromQuery(query: string) {
  const matches = query.match(URL_MATCH_REGEX) ?? [];
  const normalized = matches
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value));

  return dedupeStrings(normalized);
}

function extractDomainsFromUrls(urls: string[]) {
  const domains = urls
    .map((value) => {
      try {
        return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  return dedupeStrings(domains);
}

function stripUrlsFromQuery(query: string) {
  return query.replace(URL_MATCH_REGEX, " ").replace(/\s+/g, " ").trim();
}

function buildOptimizedSearchQuery(
  queryWithoutUrls: string,
  referencedUrls: string[],
  referencedDomains: string[],
) {
  const parts: string[] = [];

  if (queryWithoutUrls) {
    parts.push(queryWithoutUrls);
  }

  if (referencedUrls.length) {
    parts.push(...referencedUrls.map((url) => `"${url}"`));
  }

  if (referencedDomains.length) {
    parts.push(...referencedDomains.map((domain) => `site:${domain}`));
  }

  return parts.join(" ").trim();
}

function buildLlmFocusBlock({
  referencedUrls,
  referencedDomains,
  optimizedSearchQuery,
}: Pick<
  QueryOptimizationContext,
  "referencedUrls" | "referencedDomains" | "optimizedSearchQuery"
>) {
  if (!referencedUrls.length && !referencedDomains.length) {
    return "No explicit URL or domain focus provided.";
  }

  return [
    referencedUrls.length
      ? `- Explicit URLs from the user: ${referencedUrls.join(", ")}`
      : "- Explicit URLs from the user: none",
    referencedDomains.length
      ? `- Preferred domains: ${referencedDomains.join(", ")}`
      : "- Preferred domains: none",
    optimizedSearchQuery
      ? `- Search emphasis used upstream: ${optimizedSearchQuery}`
      : "- Search emphasis used upstream: none",
    "- Prioritize extracted content from the explicit URLs first when it is relevant.",
    "- Use same-domain search results as supporting context before unrelated sources.",
  ].join("\n");
}

function buildQueryOptimizationContext(query: string): QueryOptimizationContext {
  const referencedUrls = extractUrlsFromQuery(query);
  const referencedDomains = extractDomainsFromUrls(referencedUrls);
  const queryWithoutUrls = stripUrlsFromQuery(query);
  const optimizedSearchQuery =
    buildOptimizedSearchQuery(queryWithoutUrls, referencedUrls, referencedDomains) ||
    query;

  return {
    originalQuery: query,
    queryWithoutUrls,
    referencedUrls,
    referencedDomains,
    optimizedSearchQuery,
    llmFocusBlock: buildLlmFocusBlock({
      referencedUrls,
      referencedDomains,
      optimizedSearchQuery,
    }),
  };
}

function isFocusedDomainMatch(url: string, referencedDomains: string[]) {
  if (!referencedDomains.length) {
    return false;
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    return referencedDomains.includes(hostname);
  } catch {
    return false;
  }
}

function dedupeWebSearchResults(results: WebSearchResult[]) {
  const seen = new Set<string>();

  return results.filter((result) => {
    const normalizedUrl = normalizeUrl(result.url) ?? result.url;

    if (seen.has(normalizedUrl)) {
      return false;
    }

    seen.add(normalizedUrl);
    return true;
  });
}



function extractImageCandidates(results: WebSearchResult[]) {
  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];

  for (const result of results) {
    const sourceUrl = normalizeUrl(result.url);

    if (!sourceUrl) {
      continue;
    }

    const sourceDomain = new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase();
    const sourceTitle = result.title.trim() || sourceDomain;

    for (const imageUrl of result.images ?? []) {
      const normalizedImageUrl = normalizeUrl(imageUrl);

      if (!normalizedImageUrl || seen.has(normalizedImageUrl)) {
        continue;
      }

      seen.add(normalizedImageUrl);
      candidates.push({
        url: normalizedImageUrl,
        sourceUrl,
        sourceTitle,
        sourceDomain,
        sourceType: result.sourceType,
        focusedByUser: result.focusedByUser,
      });
    }
  }

  return candidates;
}

function imageCandidateFromUrl(url: string): ImageCandidate | null {
  const normalizedUrl = normalizeUrl(url);

  if (!normalizedUrl) {
    return null;
  }

  const sourceDomain = new URL(normalizedUrl).hostname.replace(/^www\./i, "").toLowerCase();

  return {
    url: normalizedUrl,
    sourceUrl: normalizedUrl,
    sourceTitle: "Tavily image result",
    sourceDomain,
    sourceType: "search",
  };
}

function dedupeImageCandidates(candidates: ImageCandidate[]) {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    if (seen.has(candidate.url)) {
      return false;
    }

    seen.add(candidate.url);
    return true;
  });
}

function buildImageFocusBlock(imageCandidates: ImageCandidate[]) {
  if (!imageCandidates.length) {
    return [
      "No verified image candidates were collected from the search pipeline.",
      "Do not invent, guess, or transform image URLs.",
      "If the user asks for images, say that no verified image links were found and only cite source pages.",
    ].join("\n");
  }

  return [
    "Only use image URLs from this section when rendering markdown images.",
    "Do not invent, guess, or transform image URLs.",
    "Each image URL below is verified from a source page in the search pipeline.",
    JSON.stringify(imageCandidates, null, 2),
  ].join("\n");
}

function buildPrompt(
  queryContext: QueryOptimizationContext,
  webSearchResponse: WebSearchResult[],
  images: string[] = []
) {
  const imageCandidates = dedupeImageCandidates([
    ...extractImageCandidates(webSearchResponse),
    ...images
      .map(imageCandidateFromUrl)
      .filter((candidate): candidate is ImageCandidate => Boolean(candidate)),
  ]);

  // Drastically reduce input tokens by stripping rawContent and sending only the snippets
  const optimizedWebSearchResponse = webSearchResponse.map((res) => ({
    title: res.title,
    url: res.url,
    content: truncateText(res.content, 600),
    sourceType: res.sourceType,
    focusedByUser: res.focusedByUser,
    images: res.images?.slice(0, 3) || [],
  }));

  return PROMPT_TEMPLATE.replace(
    "{{QUERY_FOCUS}}",
    () => queryContext.llmFocusBlock,
  ).replace(
    "{{WEB_SEARCH_RESULTS}}",
    () => JSON.stringify(optimizedWebSearchResponse),
  ).replace(
    "{{IMAGE_CANDIDATES}}",
    () => buildImageFocusBlock(imageCandidates.slice(0, 8)),
  ).replace("{{USER_QUERY}}", () => queryContext.originalQuery);
}

function setSseHeaders(res: express.Response, conversationId: string) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Conversation-ID", conversationId);
  res.flushHeaders?.();
}

function writeSse(res: express.Response, payload: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseStatus(
  res: express.Response,
  conversationId: string,
  label: string,
  detail?: string,
) {
  writeSse(res, {
    type: "status",
    label,
    detail,
    conversationId,
  });
}

function startSseKeepAlive(res: express.Response) {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keep-alive\n\n");
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);

  const cleanup = () => clearInterval(timer);
  res.on("close", cleanup);
  res.on("finish", cleanup);

  return cleanup;
}

function truncateText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildContextSnapshot(history: ChatMessage[]) {
  const userQueries = history
    .filter((message) => message.role === "user")
    .map(
      (message, index) =>
        `${index + 1}. ${truncateText(message.content, SUMMARY_USER_QUERY_CHAR_LIMIT)}`,
    );
  const recentMessages = history
    .slice(-SUMMARY_RECENT_MESSAGE_LIMIT)
    .map(
      (message) =>
        `[${message.role.toUpperCase()}]: ${truncateText(
          message.content,
          SUMMARY_MESSAGE_CHAR_LIMIT,
        )}`,
    );

  return [
    "## User Query Timeline",
    userQueries.length ? userQueries.join("\n") : "- None",
    "",
    `## Recent Conversation (${Math.min(history.length, SUMMARY_RECENT_MESSAGE_LIMIT)} messages)`,
    recentMessages.length ? recentMessages.join("\n\n") : "- None",
  ].join("\n");
}

function buildFallbackContextSummary(history: ChatMessage[]) {
  const userQueries = history
    .filter((message) => message.role === "user")
    .map(
      (message, index) =>
        `- Query ${index + 1}: ${truncateText(
          message.content,
          SUMMARY_USER_QUERY_CHAR_LIMIT,
        )}`,
    );
  const recentMessages = history
    .slice(-SUMMARY_RECENT_MESSAGE_LIMIT)
    .map(
      (message) =>
        `- Recent ${message.role}: ${truncateText(
          message.content,
          SUMMARY_MESSAGE_CHAR_LIMIT,
        )}`,
    );

  return [...userQueries, ...recentMessages].join("\n");
}

async function getWebSearchResults(query: string) {
  const queryContext = buildQueryOptimizationContext(query);

  const needsImages =
    /image|photo|picture|visual|graph|chart|show me|display|gallery/i.test(
      query,
    );
  console.log(`[Tavily] Query images needed: ${needsImages}`);

  // Run URL extraction and web search in PARALLEL instead of sequentially
  const extractionPromise = queryContext.referencedUrls.length
    ? tavly
        .extract(queryContext.referencedUrls, {
          extractDepth: "advanced",
          format: "markdown",
          includeImages: needsImages,
          includeFavicon: true,
          query: queryContext.queryWithoutUrls || undefined,
        })
        .catch((error) => {
          console.error("Direct URL extraction failed", error);
          return null;
        })
    : Promise.resolve(null);

  const searchPromise = tavly
    .search(queryContext.optimizedSearchQuery, {
      searchDepth: "basic",
      includeDomains: queryContext.referencedDomains.length
        ? queryContext.referencedDomains
        : undefined,
      includeFavicon: true,
      includeImages: needsImages,
      includeImageDescriptions: needsImages,
    })
    .catch((error) => {
      console.error("Web search failed", error);
      return null;
    });

  const [extracted, webResults] = await Promise.all([
    extractionPromise,
    searchPromise,
  ]);

  // Process extraction results
  const extractedResults: WebSearchResult[] = [];
  const extractedImages: string[] = [];

  if (extracted) {
    extractedResults.push(
      ...extracted.results.map((result) => {
        const rawContent = truncateText(
          result.rawContent ?? "",
          DIRECT_EXTRACT_CONTENT_CHAR_LIMIT,
        );

        return {
          title: result.title?.trim() || result.url,
          url: result.url,
          content: truncateText(rawContent, DIRECT_EXTRACT_SNIPPET_CHAR_LIMIT),
          rawContent,
          favicon: result.favicon,
          images: result.images ?? [],
          sourceType: "direct_url_extract" as const,
          focusedByUser: true,
        };
      }),
    );

    extracted.results.forEach((res: any) => {
      if (res.images && Array.isArray(res.images)) {
        extractedImages.push(
          ...res.images.map((img: any) =>
            typeof img === "string" ? img : img.url,
          ).filter(Boolean),
        );
      }
    });
  }

  // Process search results
  let searchResults: WebSearchResult[] = [];
  let fetchedImages: string[] = [];

  if (webResults) {
    const rawImages = (webResults as any).images || [];
    fetchedImages = rawImages
      .map((img: any) => (typeof img === "string" ? img : img.url))
      .filter(Boolean);
    console.log(
      `[Tavily] Search returned ${fetchedImages.length} images. First: ${fetchedImages[0] || "none"}`,
    );

    searchResults = (webResults.results ?? []).map((result) => ({
      ...result,
      sourceType: "search" as const,
      focusedByUser: isFocusedDomainMatch(
        result.url,
        queryContext.referencedDomains,
      ),
    }));
  }

  if (!extractedResults.length && !searchResults.length) {
    throw new Error("Both search and extraction failed");
  }

  return {
    queryContext,
    results: dedupeWebSearchResults([...extractedResults, ...searchResults]),
    images: dedupeStrings([...extractedImages, ...fetchedImages]),
  };
}

async function getConversationForUser(conversationId: string, userId: string) {
  return prisma.conversation.findFirst({
    where: {
      id: conversationId,
      userId,
    },
    select: conversationDetailSelect,
  });
}

/**
 * Generate a bulleted context summary from raw conversation history.
 * This avoids sending the full history to the LLM on long conversations.
 */
async function generateContextSummary(
  history: ChatMessage[],
): Promise<string> {
  const historyText = buildContextSnapshot(history);

  const prompt = CONTEXT_SUMMARY_PROMPT.replace(
    "{{CONVERSATION_HISTORY}}",
    () => historyText,
  );

  try {
    const completion = await groq.chat.completions.create({
      model: "qwen/qwen3-32b",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 500,
      stream: false,
    });

    return (
      completion.choices[0]?.message?.content?.trim() ??
      "No context summary available."
    );
  } catch (error) {
    console.error("Context summary generation failed", error);
    return buildFallbackContextSummary(history);
  }
}

async function streamAiResponse({
  res,
  conversationId,
  webSearchResponse,
  messages,
  onComplete,
}: {
  res: express.Response;
  conversationId: string;
  webSearchResponse: WebSearchResult[];
  messages: ChatMessage[];
  onComplete: (content: string) => Promise<void>;
}) {
  if (!res.headersSent) {
    setSseHeaders(res, conversationId);
  }

  writeSse(res, { type: "sources", sources: webSearchResponse });

  try {
    const llmStream = await groq.chat.completions.create({
      model: "qwen/qwen3-32b",
      messages,
      max_completion_tokens: 1500,
      stream: true,
    });

    writeSse(res, { type: "response_start", conversationId });

    let assistantContent = "";
    for await (const chunk of llmStream) {
      const content = chunk.choices[0]?.delta?.content ?? "";

      if (content) {
        assistantContent += content;
        writeSse(res, { type: "delta", text: content });
      }
    }

    if (assistantContent.trim()) {
      await onComplete(assistantContent);
    }

    writeSse(res, { type: "response_end", conversationId });
  } catch (error) {
    console.error("AI stream failed", error);
    writeSse(res, {
      type: "error",
      error: "AI response failed",
      conversationId,
    });
    writeSse(res, { type: "response_end", conversationId });
  } finally {
    res.end();
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Conversation-ID"],
  }),
);
app.use(express.json());

app.get("/", (req: express.Request, res: express.Response) => {
  res.json({ message: "Hello World" });
});

app.get(
  "/api/conversations",
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

  const conversation = await getConversationForUser(conversationId, userId);

  if (!conversation) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  res.json(conversation);
});

app.get("/api/conversations/:id", authorize, getConversationHandler);
app.post("/api/conversations/:id", authorize, getConversationHandler);

app.delete(
  "/api/conversations/:id",
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
      where: {
        id: conversationId,
        userId,
      },
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

app.post(
  "/api/AI",
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

      writeSseStatus(
        res,
        conversation.id,
        "Web search complete",
        `${webSearchResponse.length} source${webSearchResponse.length === 1 ? "" : "s"} found.`,
      );

      await streamAiResponse({
        res,
        conversationId: conversation.id,
        webSearchResponse,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildPrompt(queryContext, webSearchResponse, images),
          },
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
      writeSse(res, {
        type: "error",
        message: "Search or AI preparation failed",
        conversationId: conversation.id,
      });
      writeSse(res, { type: "response_end", conversationId: conversation.id });
      if (!res.writableEnded) {
        res.end();
      }
    } finally {
      stopKeepAlive();
    }
  }),
);

app.post(
  "/api/AI/follow_up",
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
      where: {
        id: conversationId,
        userId,
      },
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
      writeSseStatus(
        res,
        conversationId,
        "Web search ready",
        `${webSearchResponse.length} fresh source${webSearchResponse.length === 1 ? "" : "s"} found.`,
      );

      const userQueries = conversation.messages
        .filter((message) => message.role === "USER")
        .slice(-5)
        .map((message, index) => `- Query ${index + 1}: ${message.content}`);

      const userHistoryContext = userQueries.length > 0
        ? `\n\n## User Conversation History (Previous Queries):\n${userQueries.join("\n")}`
        : "";

      let llmMessages: ChatMessage[] = [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
      ];

      if (userHistoryContext) {
        llmMessages.push({
          role: "system",
          content: userHistoryContext,
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
      writeSse(res, {
        type: "error",
        message: "Follow-up preparation failed",
        conversationId,
      });
      writeSse(res, { type: "response_end", conversationId });
      if (!res.writableEnded) {
        res.end();
      }
    } finally {
      stopKeepAlive();
    }
  }),
);

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Unhandled API error", error);

    if (res.headersSent) {
      next(error);
      return;
    }

    res.status(500).json({ error: "Internal server error" });
  },
);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
