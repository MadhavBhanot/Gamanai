/**
 * Langfuse tracing over OpenTelemetry. Imported first by index.ts so spans exist before any AI SDK code loads.
 * Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set (LANGFUSE_BASE_URL picks the region).
 * OpenTelemetry packages stay on the 0.212 / api 1.9 line: newer ones need api 1.10, which `ai` and vitest don't
 * allow, and their nested "exports" maps crash ts-node's resolver.
 */
import "dotenv/config";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";

export const tracingEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export const langfuseSpanProcessor = tracingEnabled ? new LangfuseSpanProcessor() : null;

if (langfuseSpanProcessor) {
  new NodeSDK({ spanProcessors: [langfuseSpanProcessor] }).start();
  // Render stops the process with SIGTERM on deploys; send buffered spans first
  process.once("SIGTERM", () => {
    void langfuseSpanProcessor.forceFlush().finally(() => process.exit(0));
  });
}
