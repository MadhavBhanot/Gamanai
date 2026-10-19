import { useEffect, useState } from 'react';
import { Link } from 'react-router';

type Summary = {
  n: number;
  errors: number;
  correctness: number | null;
  faithfulness: number | null;
  citationValidity: number | null;
  citationRate: number | null;
  formatOk: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
};

type Run = {
  file: string;
  label: string;
  date: string;
  model: string;
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

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? '–' : `${(value * 100).toFixed(1)}%`;
const secs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(2)}s`;

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

  const latest = runs?.length ? runs[runs.length - 1] : null;
  const overall = latest?.summary.overall;

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
                <code>{latest.model}</code> · judge <code>{latest.judgeModel}</code> · commit{' '}
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
                <p>Answers that link at least one source URL</p>
              </div>
              <div>
                <dt>Latency p50 / p95</dt>
                <dd>
                  {secs(overall.latencyP50Ms)} / {secs(overall.latencyP95Ms)}
                </dd>
                <p>Generation time once sources are ready</p>
              </div>
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
                      <td>{pct(s.citationValidity)}</td>
                      <td>{pct(s.formatOk)}</td>
                      <td>{secs(s.latencyP95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="history-title" className="evals-section">
            <h2 id="history-title">Run history</h2>
            <div className="evals-table-wrap">
              <table className="evals-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Date</th>
                    <th scope="col">Model</th>
                    <th scope="col">Questions</th>
                    <th scope="col">Correctness</th>
                    <th scope="col">Faithfulness</th>
                    <th scope="col">Cites a source</th>
                    <th scope="col">p50 latency</th>
                  </tr>
                </thead>
                <tbody>
                  {[...runs!].reverse().map((run) => (
                    <tr key={run.file}>
                      <th scope="row">{run.label}</th>
                      <td>{new Date(run.date).toLocaleDateString()}</td>
                      <td><code>{run.model}</code></td>
                      <td>{run.summary.overall.n}</td>
                      <td>{pct(run.summary.overall.correctness)}</td>
                      <td>{pct(run.summary.overall.faithfulness)}</td>
                      <td>{pct(run.summary.overall.citationRate)}</td>
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
