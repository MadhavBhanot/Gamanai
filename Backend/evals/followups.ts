/**
 * Follow-up resolution eval: does the standalone rewrite name what the user referred to, and leave new topics alone?
 * A case passes when the rewrite contains every `expect` term and no `forbid` term (case-insensitive).
 *   npm run eval:followups            (uses REWRITE_MODELS, default Groq gpt-oss-20b then Flash-Lite)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { standaloneQuery } from "../llm/contextualize";

type Case = { id: string; history: [("user" | "assistant"), string][]; query: string; expect: string[]; forbid: string[] };

const cases: Case[] = fs
  .readFileSync(path.join(__dirname, "followups.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

(async () => {
  const times: number[] = [];
  let passed = 0;
  for (const c of cases) {
    const startedAt = Date.now();
    const rewritten = await standaloneQuery(c.query, c.history.map(([role, content]) => ({ role, content })));
    times.push(Date.now() - startedAt);
    const text = rewritten.toLowerCase();
    const ok = c.expect.every((t) => text.includes(t.toLowerCase())) && !c.forbid.some((t) => text.includes(t.toLowerCase()));
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${c.id} ${JSON.stringify(c.query)} -> ${JSON.stringify(rewritten)}`);
  }
  times.sort((a, b) => a - b);
  console.log(`\nresolved ${passed}/${cases.length} (${((passed / cases.length) * 100).toFixed(1)}%), p50 ${times[Math.floor(times.length / 2)]} ms, p95 ${times[Math.floor(times.length * 0.95)]} ms`);
})();
