import "dotenv/config";
import { tavily } from "@tavily/core";
import Groq from "groq-sdk";

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

export const groq = new Groq({
  apiKey: process.env.Groq_API_Key ?? "",
  timeout: 60_000,
});

// Groq retires models often; override with CHAT_MODEL without a redeploy of code.
export const CHAT_MODEL = process.env.CHAT_MODEL ?? "qwen/qwen3.8-27b";
