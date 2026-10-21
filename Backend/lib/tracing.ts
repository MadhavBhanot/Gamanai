import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import type { RequestHandler } from "express";
import { tracingEnabled } from "../instrumentation";

/** AI SDK telemetry for one call site; Langfuse names each generation after `functionId`. */
export const telemetry = (functionId: string) => ({ isEnabled: tracingEnabled, functionId });

/**
 * One Langfuse trace per AI request: everything the handler awaits (rewrite, search, planner, answer) runs inside
 * this observation, because OpenTelemetry context follows async calls. The trace ends when the response closes.
 * Put it after `authorize` so the user id is known.
 */
export const traceRequest =
  (route: string): RequestHandler =>
  (req, res, next) => {
    if (!tracingEnabled) return next();
    const body = (req.body ?? {}) as { query?: string; mode?: string; conversationId?: string };
    void startActiveObservation(`ai-${route}`, (span) => {
      span.update({ input: { query: body.query, mode: body.mode ?? "quick" } });
      return propagateAttributes(
        {
          userId: req.userId,
          sessionId: body.conversationId,
          tags: [route, body.mode ?? "quick"],
        },
        () =>
          new Promise<void>((resolve) => {
            res.once("close", () => {
              span.update({ output: { status: res.statusCode } });
              resolve();
            });
            next();
          }),
      );
    });
  };
