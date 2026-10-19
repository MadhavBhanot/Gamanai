/**
 * Regression gate: compare a candidate run against a baseline on the questions both share.
 *   npx ts-node evals/compare.ts <baseline.json> <candidate.json> [--max-drop 0.05]
 * Exits 1 if correctness or faithfulness drops by more than max-drop (absolute).
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { mean } from "./metrics";

type Item = { id: string; correctness?: number; faithfulness?: number | null; error?: string };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "max-drop": { type: "string", default: "0.05" } },
});
const [baselineFile, candidateFile] = positionals;
if (!baselineFile || !candidateFile) {
  console.error("usage: compare.ts <baseline.json> <candidate.json> [--max-drop 0.05]");
  process.exit(2);
}

const load = (file: string) =>
  new Map((JSON.parse(fs.readFileSync(file, "utf8")).items as Item[]).map((i) => [i.id, i]));
const baseline = load(baselineFile);
const candidate = load(candidateFile);
const shared = [...baseline.keys()].filter((id) => candidate.has(id) && !baseline.get(id)!.error);
const maxDrop = Number(values["max-drop"]);

let failed = false;
for (const metric of ["correctness", "faithfulness"] as const) {
  // An errored candidate item scores 0: a crash is a regression, not a skip.
  const before = mean(shared.map((id) => baseline.get(id)![metric]));
  const after = mean(shared.map((id) => candidate.get(id)!.error ? 0 : candidate.get(id)![metric]));
  if (before === null || after === null) continue;
  const delta = after - before;
  const regressed = delta < -maxDrop;
  failed ||= regressed;
  console.log(
    `${metric.padEnd(13)} ${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}% (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts) ${regressed ? "REGRESSION" : "ok"}`,
  );
}
console.log(`compared ${shared.length} shared questions`);
process.exit(failed ? 1 : 0);
