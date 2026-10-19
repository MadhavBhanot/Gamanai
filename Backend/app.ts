import express from "express";
import cors from "cors";
import helmet from "helmet";
import { allowedOrigins } from "./config";
import { prisma } from "./db";
import { aiRouter } from "./routes/ai";
import { conversationsRouter } from "./routes/conversations";

export const app = express();

// Behind Render's proxy: needed so the guest rate limiter sees the real client IP
app.set("trust proxy", 1);
app.use(helmet());

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

app.get("/", (_req, res) => {
  res.json({ message: "Hello World" });
});

// Pinged by the keep-alive workflow; the DB query also stops Supabase free tier from pausing.
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (error) {
    console.error("Health check DB query failed", error);
    res.status(503).json({ ok: false });
  }
});

app.use("/api/conversations", conversationsRouter);
app.use("/api/AI", aiRouter);

app.use(
  (
    error: unknown,
    _req: express.Request,
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
