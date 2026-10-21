import { tracingEnabled } from "../instrumentation";

/**
 * List-price cost of an answer, from the same model price table Langfuse uses for its cost column, so the UI and
 * Langfuse agree. Every model here runs on a free tier, so this is the "equivalent" cost, not a bill.
 * Undefined when Langfuse isn't configured, the table can't be fetched, or the model has no list price.
 */
type Price = { pattern: RegExp; input: number; output: number };

const TABLE_TTL_MS = 24 * 60 * 60 * 1000;
let table: { fetchedAt: number; prices: Price[] } | null = null;

// Langfuse match patterns use a "(?i)" prefix for case-insensitive, which JS regexes don't support inline
export function toRegExp(pattern: string) {
  return pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "i") : new RegExp(pattern);
}

async function loadPrices(): Promise<Price[]> {
  if (table && Date.now() - table.fetchedAt < TABLE_TTL_MS) return table.prices;
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
  const base = (process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const prices: Price[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`${base}/api/public/models?limit=100&page=${page}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Langfuse models ${response.status}`);
    const { data } = (await response.json()) as { data: { matchPattern: string; inputPrice: number | null; outputPrice: number | null }[] };
    for (const m of data) {
      if (m.inputPrice == null || m.outputPrice == null) continue;
      try {
        prices.push({ pattern: toRegExp(m.matchPattern), input: m.inputPrice, output: m.outputPrice });
      } catch {
        // a pattern JS can't parse just means that model gets no price
      }
    }
    if (data.length < 100) break;
  }
  table = { fetchedAt: Date.now(), prices };
  return prices;
}

/** `model` is a "provider:model" spec, e.g. "google:gemini-3.5-flash-lite". */
export async function listPriceUsd(model: string, inputTokens: number, outputTokens: number) {
  if (!tracingEnabled) return undefined;
  try {
    const modelId = model.slice(model.indexOf(":") + 1);
    const price = (await loadPrices()).find((p) => p.pattern.test(modelId));
    return price ? inputTokens * price.input + outputTokens * price.output : undefined;
  } catch (error) {
    console.warn(`[pricing] skipped: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    return undefined;
  }
}
