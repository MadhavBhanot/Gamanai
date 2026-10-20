import type express from "express";

const SSE_KEEPALIVE_INTERVAL_MS = 10_000;

export function setSseHeaders(res: express.Response, conversationId: string) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Conversation-ID", conversationId);
  res.flushHeaders?.();
}

export function formatSse(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function writeSse(res: express.Response, payload: Record<string, unknown>) {
  res.write(formatSse(payload));
}

export function writeSseStatus(
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

export function startSseKeepAlive(res: express.Response) {
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

/** Aborts when the client goes away mid-stream (Stop button, closed tab), so model calls stop spending quota. */
export function abortOnClose(res: express.Response) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("client disconnected"));
  });
  return controller.signal;
}

/** Emit error + response_end and close the stream; used when preparation fails before the LLM runs. */
export function failSse(res: express.Response, conversationId: string, message: string) {
  writeSse(res, { type: "error", message, conversationId });
  writeSse(res, { type: "response_end", conversationId });
  if (!res.writableEnded) {
    res.end();
  }
}
