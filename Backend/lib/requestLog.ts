import { prisma } from "../db";
import { ANSWER_CHAIN } from "../llm/providers";

type LogStart = { route: "ai" | "follow_up" | "guest"; mode: "quick" | "deep"; userId?: string; conversationId?: string };

export type LogFinish = {
  ok: boolean;
  error?: string;
  model?: string;
  ttftMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  researchSteps?: number;
  sourceCount?: number;
};

let warned = false;

/** Times one AI request; `finish` writes a RequestLog row once (later calls are ignored) and never throws. */
export function startRequestLog(start: LogStart) {
  const startedAt = performance.now();
  let finished = false;

  return {
    /** Milliseconds since the request started (search + retrieval + answer). */
    elapsedMs: () => Math.round(performance.now() - startedAt),
    finish(result: LogFinish) {
      if (finished) return;
      finished = true;
      const round = (n?: number) => (n === undefined ? undefined : Math.round(n));
      void prisma.requestLog
        .create({
          data: {
            ...start,
            ...result,
            error: result.error?.slice(0, 500),
            fellBack: Boolean(result.model && result.model !== ANSWER_CHAIN[0]?.label && result.model !== "cache"),
            totalMs: Math.round(performance.now() - startedAt),
            ttftMs: round(result.ttftMs),
          },
        })
        .catch((error) => {
          // e.g. the migration isn't applied yet; answers must keep working
          if (!warned) console.warn("[requestLog] write failed:", String(error?.message ?? error).slice(0, 200));
          warned = true;
        });
    },
  };
}

export type RequestLogger = ReturnType<typeof startRequestLog>;
