import { useEffect, useState } from 'react';
import { Link } from 'react-router';

type Summary = {
  n: number;
  errors: number;
  correctness: number | null;
  faithfulness: number | null;
  citationValidity: number | null;
  citationPrecision?: number | null;
  citationRate: number | null;
  formatOk: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  avgTotalTokens?: number | null;
  avgModelCalls?: number | null;
  injectionResistance?: number | null;
};

type Run = {
  file: string;
  label: string;
  date: string;
  model: string;
  retrieval?: string;
  answerMode?: 'quick' | 'deep';
  dataset?: string;
  judgeModel: string;
  git: string;
  summary: { overall: Summary; byBucket: Record<string, Summary> };
};

const BUCKET_NAMES: Record<string, string> = {
  factual: 'Factual lookup',
  multi_hop: 'Multi-hop',
  url_focus: 'URL-focused',
  false_premise: 'False premise',
};

const CONTEXT_NAMES: Record<string, string> = {
  rerank: 'Full-text recall (30) + Jina cross-encoder rerank',
  hybrid: 'Hybrid (vector + full-text, RRF)',
  vector: 'Vector only',
  fts: 'Full-text only',
  snippets: 'Search snippets',
};

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`;
const secs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(2)}s`;
// Runs before Phase 4 didn't record a total; for them it's just the answer call
const totalTokens = (s: Summary) => s.avgTotalTokens ?? (s.avgPromptTokens ?? 0) + (s.avgCompletionTokens ?? 0);

const EvalsPage = () => {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/evals.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load eval results (${response.status})`);
        return response.json() as Promise<Run[]>;
      })
      .then(setRuns)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load eval results'));
  }, []);

  const canary = (runs ?? []).filter((r) => r.dataset === 'canary').at(-1);
  // Headline = the latest full-set Quick run; subset and Deep runs get their own sections
  const fullQuick = (runs ?? []).filter((r) => r.summary.overall.n === 100 && r.answerMode !== 'deep');
  const latest = fullQuick.at(-1) ?? runs?.at(-1) ?? null;
  const overall = latest?.summary.overall;
  // The baseline used an older prompt and search cache, so it isn't a fair ablation row
  const ablation = Object.keys(CONTEXT_NAMES)
    .reverse()
    .map((mode) => fullQuick.filter((r) => (r.retrieval ?? 'snippets') === mode && r.label !== 'baseline').at(-1))
    .filter((r): r is Run => Boolean(r));
  const deepComparisons = (runs ?? [])
    .filter((r) => r.answerMode === 'deep')
    .flatMap((deep) => {
      // Latest quick run over the same questions and retrieval before this deep run (same prompt version)
      const quickFor = (bucket: string) =>
        (runs ?? [])
          .filter((r) => r.answerMode !== 'deep' && r.model === deep.model && r.retrieval === deep.retrieval && r.date < deep.date && r.summary.byBucket[bucket])
          .at(-1);
      return Object.entries(deep.summary.byBucket).flatMap(([bucket, d]) => {
        const q = quickFor(bucket)?.summary.byBucket[bucket];
        return q ? [{ id: `${deep.file}-${bucket}`, bucket, retrieval: deep.retrieval, quick: q, deep: d }] : [];
      });
    });

  // Runs labelled model-*: the same question subset and retrieval, one answer model each (latest per model)
  const modelRuns = [...new Map((runs ?? []).filter((r) => r.label.startsWith('model-')).map((r) => [r.model, r])).values()];

  return (
    <main className="evals-page">
      <header className="evals-header">
        <Link className="evals-back" to="/">← Back to Gaminai</Link>
        <p className="eyebrow">Evaluation</p>
        <h1>How well does Gaminai answer?</h1>
        <p className="evals-lede">
          Every change to the answer pipeline is scored against a fixed set of 100 questions:
          factual lookups, multi-hop questions, questions about a specific URL, and false-premise
          traps that the assistant should push back on. A separate model grades each answer
          against human-written key facts and against the sources the assistant was given.
        </p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {!runs && !error ? <p className="evals-muted">Loading results…</p> : null}
      {runs && !latest ? <p className="evals-muted">No eval runs published yet.</p> : null}

      {latest && overall ? (
        <>
          <section aria-labelledby="latest-title" className="evals-section">
            <div className="evals-section-head">
              <h2 id="latest-title">Latest run</h2>
              <p className="evals-muted">
                {latest.label} · {new Date(latest.date).toLocaleDateString()} · answer model{' '}
                <code>{latest.model}</code> · context {CONTEXT_NAMES[latest.retrieval ?? 'snippets'] ?? latest.retrieval}
                {' '}· judge <code>{latest.judgeModel}</code> · commit{' '}
                <code>{latest.git}</code>
              </p>
            </div>

            <dl className="evals-stats">
              <div>
                <dt>Correctness</dt>
                <dd>{pct(overall.correctness)}</dd>
                <p>Share of reference key facts the answer states</p>
              </div>
              <div>
                <dt>Faithfulness</dt>
                <dd>{pct(overall.faithfulness)}</dd>
                <p>Answer claims supported by the retrieved sources</p>
              </div>
              <div>
                <dt>False premises caught</dt>
                <dd>{pct(latest.summary.byBucket.false_premise?.correctness)}</dd>
                <p>Trap questions corrected instead of played along</p>
              </div>
              <div>
                <dt>Answers citing a source</dt>
                <dd>{pct(overall.citationRate)}</dd>
                <p>Answers with at least one inline [n] citation or source link</p>
              </div>
              <div>
                <dt>Citation precision</dt>
                <dd>{pct(overall.citationPrecision)}</dd>
                <p>Citations whose source actually supports the sentence</p>
              </div>
              <div>
                <dt>Latency p50 / p95</dt>
                <dd>
                  {secs(overall.latencyP50Ms)} / {secs(overall.latencyP95Ms)}
                </dd>
                <p>Generation time once sources are ready</p>
              </div>
              {canary ? (
                <div>
                  <dt>Prompt injections resisted</dt>
                  <dd>{pct(canary.summary.overall.injectionResistance)}</dd>
                  <p>{canary.summary.overall.n} pages with planted instructions the answer must ignore</p>
                </div>
              ) : null}
            </dl>
          </section>

          <section aria-labelledby="bucket-title" className="evals-section">
            <h2 id="bucket-title">By question type</h2>
            <div className="evals-table-wrap">
              <table className="evals-table">
                <thead>
                  <tr>
                    <th scope="col">Bucket</th>
                    <th scope="col">Questions</th>
                    <th scope="col">Correctness</th>
                    <th scope="col">Faithfulness</th>
                    <th scope="col">Cites a source</th>
                    <th scope="col">Citation precision</th>
                    <th scope="col">Valid citations</th>
                    <th scope="col">Format followed</th>
                    <th scope="col">p95 latency</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(latest.summary.byBucket).map(([bucket, s]) => (
                    <tr key={bucket}>
                      <th scope="row">{BUCKET_NAMES[bucket] ?? bucket}</th>
                      <td>{s.n - s.errors}{s.errors ? ` (${s.errors} failed)` : ''}</td>
                      <td>{pct(s.correctness)}</td>
                      <td>{pct(s.faithfulness)}</td>
                      <td>{pct(s.citationRate)}</td>
                      <td>{pct(s.citationPrecision)}</td>
                      <td>{pct(s.citationValidity)}</td>
                      <td>{pct(s.formatOk)}</td>
                      <td>{secs(s.latencyP95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {ablation.length > 1 ? (
            <section aria-labelledby="ablation-title" className="evals-section">
              <h2 id="ablation-title">Retrieval ablation</h2>
              <p className="evals-muted">
                Same 100 questions, same cached search results, same answer model; only the passages the model sees change.
              </p>
              <div className="evals-table-wrap">
                <table className="evals-table">
                  <thead>
                    <tr>
                      <th scope="col">Context</th>
                      <th scope="col">Correctness</th>
                      <th scope="col">Faithfulness</th>
                      <th scope="col">Citation precision</th>
                      <th scope="col">Multi-hop correct / faithful</th>
                      <th scope="col">URL-focused correct / faithful</th>
                      <th scope="col">p50 latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ablation.map((run) => {
                      const s = run.summary.overall;
                      const mh = run.summary.byBucket.multi_hop;
                      const url = run.summary.byBucket.url_focus;
                      return (
                        <tr key={run.file}>
                          <th scope="row">{CONTEXT_NAMES[run.retrieval ?? 'snippets']}</th>
                          <td>{pct(s.correctness)}</td>
                          <td>{pct(s.faithfulness)}</td>
                          <td>{pct(s.citationPrecision)}</td>
                          <td>{pct(mh?.correctness)} / {pct(mh?.faithfulness)}</td>
                          <td>{pct(url?.correctness)} / {pct(url?.faithfulness)}</td>
                          <td>{secs(s.latencyP50Ms)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {deepComparisons.length ? (
            <section aria-labelledby="deep-title" className="evals-section">
              <h2 id="deep-title">Quick vs Deep research</h2>
              <p className="evals-muted">
                Deep mode lets an agent plan several searches before answering. Latency and tokens include the research loop.
              </p>
              <div className="evals-table-wrap">
                <table className="evals-table">
                  <thead>
                    <tr>
                      <th scope="col">Questions</th>
                      <th scope="col">Mode</th>
                      <th scope="col">Correctness</th>
                      <th scope="col">Faithfulness</th>
                      <th scope="col">Citation precision</th>
                      <th scope="col">p50 latency</th>
                      <th scope="col">Tokens / answer</th>
                      <th scope="col">Model calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deepComparisons.flatMap((c) =>
                      (['quick', 'deep'] as const).map((mode) => {
                        const s = c[mode];
                        return (
                          <tr key={`${c.id}-${mode}`}>
                            <th scope="row">
                              {BUCKET_NAMES[c.bucket] ?? c.bucket} ({CONTEXT_NAMES[c.retrieval ?? 'snippets']})
                            </th>
                            <td>{mode === 'deep' ? 'Deep' : 'Quick'}</td>
                            <td>{pct(s.correctness)}</td>
                            <td>{pct(s.faithfulness)}</td>
                            <td>{pct(s.citationPrecision)}</td>
                            <td>{secs(s.latencyP50Ms)}</td>
                            <td>{Math.round(totalTokens(s)).toLocaleString()}</td>
                            <td>{(s.avgModelCalls ?? 1).toFixed(1)}</td>
                          </tr>
                        );
                      }),
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {modelRuns.length > 1 ? (
            <section aria-labelledby="models-title" className="evals-section">
              <h2 id="models-title">Answer model comparison</h2>
              <p className="evals-muted">
                Same {modelRuns[0].summary.overall.n} questions (5 per type), same cached search results and{' '}
                {CONTEXT_NAMES[modelRuns[0].retrieval ?? 'snippets']?.toLowerCase()} context; only the answer model changes.
                All run on free tiers, so latency includes provider queueing.
              </p>
              <div className="evals-table-wrap">
                <table className="evals-table">
                  <thead>
                    <tr>
                      <th scope="col">Answer model</th>
                      <th scope="col">Correctness</th>
                      <th scope="col">Faithfulness</th>
                      <th scope="col">Citation precision</th>
                      <th scope="col">False premises caught</th>
                      <th scope="col">First token p50</th>
                      <th scope="col">p50 latency</th>
                      <th scope="col">Tokens / answer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelRuns.map((run) => {
                      const s = run.summary.overall;
                      return (
                        <tr key={run.file}>
                          <th scope="row"><code>{run.model}</code>{s.errors ? ` (${s.errors} failed)` : ''}</th>
                          <td>{pct(s.correctness)}</td>
                          <td>{pct(s.faithfulness)}</td>
                          <td>{pct(s.citationPrecision)}</td>
                          <td>{pct(run.summary.byBucket.false_premise?.correctness)}</td>
                          <td>{secs(s.ttftP50Ms)}</td>
                          <td>{secs(s.latencyP50Ms)}</td>
                          <td>{Math.round(totalTokens(s)).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section aria-labelledby="history-title" className="evals-section">
            <h2 id="history-title">Run history</h2>
            <div className="evals-table-wrap">
              <table className="evals-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Date</th>
                    <th scope="col">Model</th>
                    <th scope="col">Context</th>
                    <th scope="col">Questions</th>
                    <th scope="col">Correctness</th>
                    <th scope="col">Faithfulness</th>
                    <th scope="col">Cites a source</th>
                    <th scope="col">Citation precision</th>
                    <th scope="col">p50 latency</th>
                  </tr>
                </thead>
                <tbody>
                  {[...runs!].reverse().map((run) => (
                    <tr key={run.file}>
                      <th scope="row">{run.label}</th>
                      <td>{new Date(run.date).toLocaleDateString()}</td>
                      <td><code>{run.model}</code></td>
                      <td>
                        {CONTEXT_NAMES[run.retrieval ?? 'snippets'] ?? run.retrieval}
                        {run.answerMode === 'deep' ? ' · Deep' : ''}
                      </td>
                      <td>{run.summary.overall.n}</td>
                      <td>{pct(run.summary.overall.correctness)}</td>
                      <td>{pct(run.summary.overall.faithfulness)}</td>
                      <td>{pct(run.summary.overall.citationRate)}</td>
                      <td>{pct(run.summary.overall.citationPrecision)}</td>
                      <td>{secs(run.summary.overall.latencyP50Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
};

export default EvalsPage;
