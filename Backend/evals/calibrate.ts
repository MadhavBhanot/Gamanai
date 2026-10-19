/**
 * Judge calibration against human labels (Cohen's kappa on "is this answer correct?").
 *
 *   npx ts-node evals/calibrate.ts export evals/results/<run>.json   -> writes evals/calibration/labels.json
 *   (open labels.json, set every "human_correct" to true/false)
 *   npx ts-node evals/calibrate.ts score                              -> prints agreement + kappa
 */
import fs from "node:fs";
import path from "node:path";
import { cohenKappa } from "./metrics";

const LABELS = path.join(__dirname, "calibration", "labels.json");
const SAMPLE_SIZE = 30;

type Label = {
  id: string;
  bucket: string;
  query: string;
  key_facts: string[];
  answer: string;
  judge_correct: boolean;
  human_correct: boolean | null;
};

const [command, runFile] = process.argv.slice(2);

if (command === "export" && runFile) {
  const dataset = new Map(
    fs.readFileSync(path.join(__dirname, "dataset.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => [c.id, c]),
  );
  const items = JSON.parse(fs.readFileSync(runFile, "utf8")).items.filter((i: { error?: string }) => !i.error);
  // Evenly spaced sample keeps every bucket represented without randomness
  const step = Math.max(1, items.length / SAMPLE_SIZE);
  const labels: Label[] = Array.from({ length: Math.min(SAMPLE_SIZE, items.length) }, (_, k) => items[Math.floor(k * step)])
    .map((i) => ({
      id: i.id,
      bucket: i.bucket,
      query: i.query,
      key_facts: dataset.get(i.id).key_facts,
      answer: i.answer,
      judge_correct: i.correctness >= 0.5,
      human_correct: null,
    }));
  fs.mkdirSync(path.dirname(LABELS), { recursive: true });
  fs.writeFileSync(LABELS, JSON.stringify(labels, null, 2));
  console.log(`Wrote ${labels.length} items to ${LABELS}. Fill in human_correct, then run "score".`);
} else if (command === "score") {
  const labels: Label[] = JSON.parse(fs.readFileSync(LABELS, "utf8"));
  const done = labels.filter((l) => typeof l.human_correct === "boolean");
  if (!done.length) throw new Error("No human_correct labels filled in yet");
  const judge = done.map((l) => l.judge_correct);
  const human = done.map((l) => l.human_correct as boolean);
  const agreement = judge.filter((v, i) => v === human[i]).length / done.length;
  const kappa = cohenKappa(judge, human);
  console.log(`labelled ${done.length}/${labels.length}  agreement ${(agreement * 100).toFixed(1)}%  Cohen's kappa ${kappa.toFixed(3)}`);
  fs.writeFileSync(
    path.join(path.dirname(LABELS), "result.json"),
    JSON.stringify({ labelled: done.length, agreement, kappa, date: new Date().toISOString() }, null, 2),
  );
} else {
  console.error("usage: calibrate.ts export <run.json> | score");
  process.exit(2);
}
