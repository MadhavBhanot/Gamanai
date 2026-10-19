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
import Groq from "groq-sdk";
import { CHAT_MODEL } from "../config";
import { generateAnswer, prepareAnswer } from "../llm/answer";
import { withTimeout } from "../lib/timeout";
import { getWebSearchResults } from "../retrieval/search";
import { JUDGE_MODEL, judgeAnswer } from "./judge";
import { estimateTokens, parseRetryDelayMs, TokenPacer } from "./pacer";
import {
  citationValidity,
  extractCitedUrls,
  mean,
  parseAnswerSections,
  percentile,
  type EvalCase,
} from "./metrics";

const EVAL_DIR = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../../evals")
  : __dirname;
const CACHE_DIR = path.join(EVAL_DIR, "cache");
const RESULTS_DIR = path.join(EVAL_DIR, "results");
const PUBLIC_INDEX = path.resolve(EVAL_DIR, "../../Frontend/Gaminai/public/evals.json");

const { values: args } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    bucket: { type: "string" },
    "per-bucket": { type: "string" },
    concurrency: { type: "string", default: "2" },
    fresh: { type: "boolean", default: false },
  },
});

// maxRetries 0: we retry 429s ourselves so latency is measured per attempt, not including backoff.
const client = new Groq({ apiKey: process.env.Groq_API_Key ?? "", maxRetries: 0, timeout: 120_000 });

// Groq free tier: 8k tokens/min per model. Budget 90% of it so bursts don't trip 429s.
const TPM_BUDGET = Number(process.env.EVAL_TPM ?? 8000) * 0.9;
const answerPacer = new TokenPacer(TPM_BUDGET);
const judgePacer = JUDGE_MODEL === CHAT_MODEL ? answerPacer : new TokenPacer(TPM_BUDGET);
const ANSWER_MAX_TOKENS = 1500; // matches generateAnswer's max_completion_tokens
const JUDGE_MAX_TOKENS = 2000; // matches judgeAnswer's max_completion_tokens

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
      const status = (error as { status?: number }).status;
      if (status !== 429 || attempt >= 15) throw error;
      const message = String((error as Error).message);
      const waitMs =
        parseRetryDelayMs(message) ??
        Number((error as { headers?: Headers }).headers?.get?.("retry-after") || 10) * 1000;
      if (/per day|\(TPD\)|\(RPD\)/i.test(message) && waitMs > 15 * 60_000) {
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
    .readFileSync(path.join(EVAL_DIR, "dataset.jsonl"), "utf8")
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

async function evaluate(testCase: EvalCase) {
  const prepared = await prepareAnswer(testCase.query, [], cachedSearch);
  const answerEstimate = estimateTokens(JSON.stringify(prepared.messages)) + ANSWER_MAX_TOKENS;
  const answer = await withRateLimitRetry(async () => {
    await answerPacer.take(answerEstimate);
    return generateAnswer(prepared.messages, undefined, client);
  });
  const parsed = parseAnswerSections(answer.content);
  // Judge input ≈ instructions + snippets (600 chars each) + answer
  const judgeEstimate =
    estimateTokens(parsed.answer) + prepared.results.length * 180 + 600 + JUDGE_MAX_TOKENS;
  const verdict = await withRateLimitRetry(async () => {
    await judgePacer.take(judgeEstimate);
    return judgeAnswer(client, testCase, prepared.results, parsed.answer);
  });

  const factCoverage = verdict.key_facts_covered.filter(Boolean).length / testCase.key_facts.length;
  const cited = extractCitedUrls(parsed.answer);

  return {
    id: testCase.id,
    bucket: testCase.bucket,
    query: testCase.query,
    correctness: testCase.should_refuse
      ? Number(Boolean(verdict.handled_false_premise))
      : verdict.contradicts_key_facts ? 0 : factCoverage,
    faithfulness: verdict.claims_total ? verdict.claims_supported / verdict.claims_total : null,
    citationValidity: citationValidity(cited, prepared.results.map((r) => r.url), prepared.images),
    hasCitation: cited.length > 0,
    formatOk: parsed.formatOk,
    ttftMs: Math.round(answer.ttftMs),
    totalMs: Math.round(answer.totalMs),
    promptTokens: answer.promptTokens,
    completionTokens: answer.completionTokens,
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
    citationRate: rate((i) => i.hasCitation),
    formatOk: rate((i) => i.formatOk),
    latencyP50Ms: percentile(ok.map((i) => i.totalMs), 50),
    latencyP95Ms: percentile(ok.map((i) => i.totalMs), 95),
    ttftP50Ms: percentile(ok.map((i) => i.ttftMs), 50),
    ttftP95Ms: percentile(ok.map((i) => i.ttftMs), 95),
    avgPromptTokens: mean(ok.map((i) => i.promptTokens)),
    avgCompletionTokens: mean(ok.map((i) => i.completionTokens)),
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

  console.log(`Evaluating ${cases.length} cases with ${CHAT_MODEL}, judged by ${JUDGE_MODEL}`);

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
  const meta = { label: args.label, date, model: CHAT_MODEL, judgeModel: JUDGE_MODEL, git: gitSha(), freshSearch: args.fresh };
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
          citeValid: pct(s.citationValidity),
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
