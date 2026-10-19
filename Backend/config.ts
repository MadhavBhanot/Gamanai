import "dotenv/config";
import { tavily } from "@tavily/core";

export const port = Number(process.env.PORT ?? 8000);

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// CORS_ORIGINS: comma-separated list of deployed frontend origins (e.g. the Vercel URL)
export const allowedOrigins = new Set([
  ...defaultOrigins,
  ...(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

export const GUEST_DAILY_LIMIT = Number(process.env.GUEST_DAILY_LIMIT ?? 5);

export const tavly = tavily({
  apiKey: process.env.TAVILY_API_KEY ?? "",
});

// LLM models are configured in llm/providers.ts (ANSWER_MODELS fallback chain).
