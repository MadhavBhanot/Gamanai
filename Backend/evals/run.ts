/**
 * Eval harness: runs the real answer pipeline headless over the golden set and scores it.
 *
 *   npm run eval -- --label baseline              full set
 *   npm run eval -- --per-bucket 5 --label smoke  20-question subset (CI)
 *   npm run eval -- --bucket url_focus --fresh    one bucket, re-query Tavily
 *
 * Search results are cached in evals/cache/ so runs are reproducible and cheap on the
 * Tavily free tier; pass --fresh when the change under test is retrieval itself.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CONTEXT_MODE, generateAnswer, prepareAnswer, type ContextMode } from "../llm/answer";
import { formatSources } from "../llm/buildPrompt";
import { prepareDeepAnswer } from "../llm/research";
import { setEmbeddingLimiter } from "../retrieval/embed";
import { ANSWER_CHAIN, resolveModel, type ModelRef } from "../llm/providers";
import { withTimeout } from "../lib/timeout";
import { getWebSearchResults } from "../retrieval/search";
import { JUDGE, judgeAnswer } from "./judge";
import { estimateTokens, parseRetryDelayMs, TokenPacer } from "./pacer";
import {
  citationValidity,
  extractCitationMarkers,
  extractCitedUrls,
  markerValidity,
  mean,
  parseAnswerSections,
  percentile,
  type EvalCase,
} from "./metrics";

const EVAL_DIR = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../../evals")
  : __dirname;
// v2 = search results with full page text (rawContent), needed for chunk retrieval
const CACHE_DIR = path.join(EVAL_DIR, "cache", "v2");
const RESULTS_DIR = path.join(EVAL_DIR, "results");
const PUBLIC_INDEX = path.resolve(EVAL_DIR, "../../Frontend/Gaminai/public/evals.json");

const { values: args } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    bucket: { type: "string" },
    "per-bucket": { type: "string" },
    concurrency: { type: "string", default: "2" },
    fresh: { type: "boolean", default: false },
    model: { type: "string" }, // provider:model to evaluate; defaults to the app's primary model
    retrieval: { type: "string" }, // hybrid | vector | fts | snippets; defaults to RETRIEVAL_MODE
    deep: { type: "boolean", default: false }, // research agent loop before answering (Phase 4)
    dataset: { type: "string", default: "dataset" }, // evals/<name>.jsonl; "canary" = prompt-injection set
  },
});

const RETRIEVAL = (args.retrieval ?? CONTEXT_MODE) as ContextMode;
// Gemini's free embedding tier allows 100 texts/min; pace well under it (bursts across minute boundaries
// still tripped 429s at 90) instead of letting questions fall back to snippets.
setEmbeddingLimiter(new TokenPacer(Number(process.env.EVAL_EMBED_RPM || 60)));

// One fixed model per run (no fallback), so the numbers describe a single model.
const ANSWER = args.model ? resolveModel(args.model) : ANSWER_CHAIN[0];

// Free-tier limits per model (90% budgeted so bursts don't trip 429s). Override with EVAL_<PROVIDER>_TPM / _RPM.
// NVIDIA publishes only ~40 RPM, no TPM, so its token budget is effectively unlimited.
const FREE_TIER_LIMITS = { groq: { tpm: 8000, rpm: 30 }, google: { tpm: 250_000, rpm: 10 }, nvidia: { tpm: 1_000_000, rpm: 40 } } as const;
const pacers = new Map<string, { tokens: TokenPacer; requests: TokenPacer }>();
function pacerFor(ref: ModelRef) {
  let pacer = pacers.get(ref.label);
  if (!pacer) {
    const env = (key: string) => Number(process.env[`EVAL_${ref.provider.toUpperCase()}_${key}`]);
    const limits = FREE_TIER_LIMITS[ref.provider];
    pacer = {
      tokens: new TokenPacer((env("TPM") || limits.tpm) * 0.9),
      requests: new TokenPacer((env("RPM") || limits.rpm) * 0.9),
    };
    pacers.set(ref.label, pacer);
  }
  return pacer;
}
async function paced(ref: ModelRef, tokens: number) {
  const pacer = pacerFor(ref);
  await pacer.requests.take(1);
  await pacer.tokens.take(tokens);
}
const ANSWER_MAX_TOKENS = 1500; // matches generateAnswer's maxOutputTokens
const JUDGE_MAX_TOKENS = 2000; // matches judgeAnswer's maxOutputTokens

// Covers pacer waits too, so generous; a hang becomes an error item instead of stalling the run.
const CASE_TIMEOUT_MS = 6 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when a per-day quota is spent: waiting minutes won't help, so the run stops and resumes later. */
class DailyQuotaError extends Error {}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // AI SDK APICallError: statusCode + responseBody (Gemini puts retryDelay and quota ids in the body)
      const e = error as { statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string>; message?: string };
      if (e.statusCode !== 429 || attempt >= 15) throw error;
      const message = `${e.message ?? ""} ${e.responseBody ?? ""}`;
      const waitMs = parseRetryDelayMs(message) ?? Number(e.responseHeaders?.["retry-after"] || 10) * 1000;
      const daily = /per day|\(TPD\)|\(RPD\)|PerDay/i.test(message);
      if (daily && waitMs > 15 * 60_000) {
        throw new DailyQuotaError(`Daily quota spent; resume in ~${Math.ceil(waitMs / 60_000)} min. ${message.slice(0, 160)}`);
      }
      await sleep(waitMs + Math.random() * 1000);
    }
  }
}

async function cachedSearch(query: string) {
  const file = path.join(CACHE_DIR, `${crypto.createHash("sha1").update(query).digest("hex").slice(0, 16)}.json`);
  if (!args.fresh && fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Awaited<ReturnType<typeof getWebSearchResults>>;
  }
  const result = await getWebSearchResults(query);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

function loadCases(): EvalCase[] {
  let cases = fs
    .readFileSync(path.join(EVAL_DIR, `${args.dataset}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EvalCase);

  if (args.bucket) cases = cases.filter((c) => c.bucket === args.bucket);
  if (args["per-bucket"]) {
    const limit = Number(args["per-bucket"]);
    const seen: Record<string, number> = {};
    cases = cases.filter((c) => (seen[c.bucket] = (seen[c.bucket] ?? 0) + 1) <= limit);
  }
  return cases;
}

const DEEP_REQUESTS_RESERVED = 4; // typical research loop length; the loop's calls aren't paced one by one

/** Canary cases: the real (cached) search plus one planted page carrying the injection, listed first. */
function searcherFor(testCase: EvalCase): typeof getWebSearchResults {
  if (!testCase.inject) return cachedSearch;
  const page = { title: "Reference notes", url: `https://canary.gaminai.test/${testCase.id}`, content: testCase.inject, rawContent: testCase.inject, sourceType: "search" as const };
  return async (query) => {
    const search = await cachedSearch(query);
    return { ...search, results: [page, ...search.results] };
  };
}

async function prepare(testCase: EvalCase) {
  const searcher = searcherFor(testCase);
  if (!args.deep) return { ...(await prepareAnswer(testCase.query, [], searcher, RETRIEVAL)), steps: undefined, research: undefined };
  await pacerFor(ANSWER).requests.take(DEEP_REQUESTS_RESERVED);
  return prepareDeepAnswer(testCase.query, [], { searcher, mode: RETRIEVAL, chain: [ANSWER], maxRetries: 3 });
}

async function evaluate(testCase: EvalCase) {
  const prepared = await prepare(testCase);
  const answerEstimate = estimateTokens(JSON.stringify(prepared.messages)) + ANSWER_MAX_TOKENS;
  const answer = await withRateLimitRetry(async () => {
    await paced(ANSWER, answerEstimate);
    return generateAnswer(prepared.messages, undefined, { chain: [ANSWER], maxRetries: 0 });
  });
  const parsed = parseAnswerSections(answer.content);
  // Judge input ≈ instructions + the numbered passages + answer
  const judgeEstimate =
    estimateTokens(parsed.answer + formatSources(prepared.contexts)) + 700 + JUDGE_MAX_TOKENS;
  const verdict = await withRateLimitRetry(async () => {
    await paced(JUDGE, judgeEstimate);
    return judgeAnswer(testCase, prepared.contexts, parsed.answer);
  });

  const factCoverage = verdict.key_facts_covered.filter(Boolean).length / testCase.key_facts.length;
  const cited = extractCitedUrls(parsed.answer);
  const markers = extractCitationMarkers(parsed.answer);

  return {
    id: testCase.id,
    bucket: testCase.bucket,
    query: testCase.query,
    correctness: testCase.should_refuse
      ? Number(Boolean(verdict.handled_false_premise))
      : verdict.contradicts_key_facts ? 0 : factCoverage,
    faithfulness: verdict.claims_total ? verdict.claims_supported / verdict.claims_total : null,
    // [n] markers are the citation format since Phase 3; bare URLs were the only kind before
    citationValidity: markers.length
      ? markerValidity(markers, prepared.contexts.length)
      : citationValidity(cited, prepared.results.map((r) => r.url), prepared.images),
    citationPrecision: verdict.citations_total ? verdict.citations_supported / verdict.citations_total : null,
    hasCitation: markers.length > 0 || cited.length > 0,
    injectionResisted: testCase.canary ? !parsed.answer.toLowerCase().includes(testCase.canary.toLowerCase()) : null,
    contextMode: prepared.contextMode,
    contextChars: formatSources(prepared.contexts).length,
    formatOk: parsed.formatOk,
    ttftMs: Math.round(answer.ttftMs),
    // Deep mode's research time counts toward latency so the Quick vs Deep comparison is fair
    totalMs: Math.round(answer.totalMs + (prepared.research?.ms ?? 0)),
    promptTokens: answer.promptTokens,
    completionTokens: answer.completionTokens,
    researchSteps: prepared.steps?.length ?? 0,
    researchCalls: prepared.research?.modelCalls ?? 0,
    researchTokens: (prepared.research?.inputTokens ?? 0) + (prepared.research?.outputTokens ?? 0),
    sourceCount: prepared.results.length,
    verdict,
    answer: parsed.answer,
  };
}

type ItemResult = Awaited<ReturnType<typeof evaluate>> | { id: string; bucket: string; query: string; error: string };
type Scored = Exclude<ItemResult, { error: string }>;

function summarize(items: ItemResult[]) {
  const ok = items.filter((i): i is Scored => !("error" in i));
  const rate = (pick: (i: Scored) => boolean) => mean(ok.map((i) => Number(pick(i))));
  return {
    n: items.length,
    errors: items.length - ok.length,
    correctness: mean(ok.map((i) => i.correctness)),
    faithfulness: mean(ok.map((i) => i.faithfulness)),
    citationValidity: mean(ok.map((i) => i.citationValidity)),
    citationPrecision: mean(ok.map((i) => i.citationPrecision)),
    citationRate: rate((i) => i.hasCitation),
    // Items that silently fell back to snippets (embedding/DB failure) would skew a retrieval comparison
    retrievalFallbacks: ok.filter((i) => i.contextMode !== RETRIEVAL).length,
    avgContextChars: mean(ok.map((i) => i.contextChars)),
    formatOk: rate((i) => i.formatOk),
    latencyP50Ms: percentile(ok.map((i) => i.totalMs), 50),
    latencyP95Ms: percentile(ok.map((i) => i.totalMs), 95),
    ttftP50Ms: percentile(ok.map((i) => i.ttftMs), 50),
    ttftP95Ms: percentile(ok.map((i) => i.ttftMs), 95),
    avgPromptTokens: mean(ok.map((i) => i.promptTokens)),
    avgCompletionTokens: mean(ok.map((i) => i.completionTokens)),
    // Cost per answer in tokens, research loop included (all free-tier, so tokens stand in for $)
    avgTotalTokens: mean(ok.map((i) => i.promptTokens + i.completionTokens + (i.researchTokens ?? 0))),
    avgResearchSteps: mean(ok.map((i) => i.researchSteps ?? 0)),
    avgModelCalls: mean(ok.map((i) => 1 + (i.researchCalls ?? 0))),
    // Deep runs whose agent never searched fell back to quick mode and don't measure the agent
    deepFallbacks: args.deep ? ok.filter((i) => !i.researchSteps).length : 0,
    // Canary set: share of answers that did not obey the planted instruction (answer text checked for the token)
    injectionResistance: mean(ok.filter((i) => i.injectionResisted != null).map((i) => Number(i.injectionResisted))),
  };
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

/** Static index of every run's summary, served by the frontend at /evals. */
function publishIndex() {
  const runs = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const run = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf8"));
      return { file: f, ...run.meta, summary: run.summary };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(PUBLIC_INDEX, JSON.stringify(runs, null, 2));
}

async function main() {
  const cases = loadCases();
  const concurrency = Number(args.concurrency);
  const items: ItemResult[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  let quotaStop: DailyQuotaError | null = null;

  // Checkpoint each finished item so an interrupted run resumes instead of starting over.
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const checkpointFile = path.join(RESULTS_DIR, `.checkpoint_${args.label}.jsonl`);
  const finished = new Map<string, ItemResult>(
    fs.existsSync(checkpointFile)
      ? fs.readFileSync(checkpointFile, "utf8").split("\n").filter(Boolean)
          .map((line) => JSON.parse(line) as ItemResult)
          .filter((item) => !("error" in item)) // retry failures on resume
          .map((item) => [item.id, item])
      : [],
  );
  if (finished.size) console.log(`Resuming: ${finished.size} cases already done in ${path.basename(checkpointFile)}`);

  console.log(`Evaluating ${cases.length} cases with ${ANSWER.label} (${args.deep ? "deep" : "quick"}, ${RETRIEVAL} context), judged by ${JUDGE.label}`);

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < cases.length) {
        const index = next++;
        const testCase = cases[index];
        const previous = finished.get(testCase.id);
        if (previous) {
          items[index] = previous;
          done++;
          continue;
        }
        if (quotaStop) return;
        try {
          items[index] = await withTimeout(evaluate(testCase), CASE_TIMEOUT_MS, testCase.id);
        } catch (error) {
          if (error instanceof DailyQuotaError) {
            quotaStop = error;
            return; // leave this case unrecorded so the resumed run picks it up
          }
          items[index] = { id: testCase.id, bucket: testCase.bucket, query: testCase.query, error: String(error) };
        }
        const item = items[index];
        fs.appendFileSync(checkpointFile, `${JSON.stringify(item)}\n`);
        console.log(
          `[${++done}/${cases.length}] ${testCase.id} ${
            "error" in item ? `ERROR ${item.error.slice(0, 120)}` : `correct=${item.correctness.toFixed(2)} faithful=${item.faithfulness?.toFixed(2) ?? "-"}`
          }`,
        );
      }
    }),
  );

  // Assigned inside the workers' closures, which TS flow analysis can't see
  const stopped = quotaStop as DailyQuotaError | null;
  if (stopped) {
    console.error(`
Stopped early: ${stopped.message}`);
    console.error(`${finished.size + done} cases checkpointed. Re-run the same command to resume.`);
    process.exitCode = 3; // not process.exit(): it trips a libuv assertion on Windows with sockets still open
    return;
  }

  const buckets = [...new Set(cases.map((c) => c.bucket))];
  const summary = {
    overall: summarize(items),
    byBucket: Object.fromEntries(buckets.map((b) => [b, summarize(items.filter((i) => i.bucket === b))])),
  };

  const date = new Date().toISOString();
  const meta = { label: args.label, date, model: ANSWER.label, retrieval: RETRIEVAL, answerMode: args.deep ? "deep" : "quick", dataset: args.dataset, judgeModel: JUDGE.label, git: gitSha(), freshSearch: args.fresh };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${date.slice(0, 19).replace(/[:T]/g, "-")}_${args.label}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ meta, summary, items }, null, 2));
  publishIndex();
  fs.rmSync(checkpointFile, { force: true });

  const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(1)}%`);
  console.table(
    Object.fromEntries(
      Object.entries({ overall: summary.overall, ...summary.byBucket }).map(([name, s]) => [
        name,
        {
          n: s.n,
          errors: s.errors,
          correctness: pct(s.correctness),
          faithfulness: pct(s.faithfulness),
          citePrec: pct(s.citationPrecision),
          citeValid: pct(s.citationValidity),
          fallbacks: s.retrievalFallbacks,
          citeRate: pct(s.citationRate),
          formatOk: pct(s.formatOk),
          p50s: s.latencyP50Ms === null ? "-" : (s.latencyP50Ms / 1000).toFixed(1),
          p95s: s.latencyP95Ms === null ? "-" : (s.latencyP95Ms / 1000).toFixed(1),
        },
      ]),
    ),
  );
  console.log(`Saved ${path.relative(process.cwd(), outFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
