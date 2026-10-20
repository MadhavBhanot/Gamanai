import { normalizeUrl } from "../retrieval/query";

export type EvalCase = {
  id: string;
  bucket: "factual" | "multi_hop" | "url_focus" | "false_premise" | "injection";
  query: string;
  key_facts: string[];
  should_refuse: boolean;
  // canary.jsonl: `inject` is planted as an extra fetched page; the answer fails if it contains `canary`
  inject?: string;
  canary?: string;
};

/** Split the model's tagged output into answer text and follow-up questions. */
export function parseAnswerSections(raw: string) {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const answer = withoutThink.match(/<ANSWER>([\s\S]*?)(<\/ANSWER>|<FOLLOW_UPS>|$)/i)?.[1]?.trim() ?? "";
  const followUpsBlock = withoutThink.match(/<FOLLOW_UPS>([\s\S]*?)(<\/FOLLOW_UPS>|$)/i)?.[1] ?? "";
  const followUps = [...followUpsBlock.matchAll(/<question>([\s\S]*?)<\/question>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  return {
    answer: answer || withoutThink.trim(),
    followUps,
    // Contract from SYSTEM_PROMPT: an <ANSWER> block plus 3-4 follow-up questions
    formatOk: Boolean(answer) && followUps.length >= 3 && followUps.length <= 4,
  };
}

/** URLs the answer cites (markdown links and bare URLs), normalized and deduped. */
export function extractCitedUrls(answer: string) {
  const urls = answer.match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? [];
  return [...new Set(urls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)))];
}

/** Inline [n] citation numbers in order of appearance (markdown links like [text](url) excluded). */
export function extractCitationMarkers(answer: string) {
  return [...answer.matchAll(/\[(\d{1,2})\](?!\()/g)].map((m) => Number(m[1]));
}

/** Share of [n] markers that point at a passage the model was actually given. */
export function markerValidity(markers: number[], contextCount: number) {
  if (!markers.length) return null;
  return markers.filter((n) => n >= 1 && n <= contextCount).length / markers.length;
}

/** Share of cited URLs that point at a retrieved source page (or an image from one). */
export function citationValidity(cited: string[], sourceUrls: string[], imageUrls: string[] = []) {
  if (!cited.length) return null;
  const known = new Set([...sourceUrls, ...imageUrls].map((u) => normalizeUrl(u) ?? u));
  return cited.filter((u) => known.has(u)).length / cited.length;
}

export function mean(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Cohen's kappa for two raters over binary labels. */
export function cohenKappa(a: boolean[], b: boolean[]) {
  if (a.length !== b.length || !a.length) throw new Error("kappa needs two equal, non-empty label lists");
  const n = a.length;
  const observed = a.filter((v, i) => v === b[i]).length / n;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const expected = pa * pb + (1 - pa) * (1 - pb);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}
