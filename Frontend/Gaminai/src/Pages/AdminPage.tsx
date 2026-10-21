import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { API_BASE_URL } from '../lib/api';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

type Day = {
  day: string;
  requests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  avgTokens: number | null;
  errors: number;
  fallbacks: number;
  cacheHits?: number;
  deep: number;
};

type FeedbackRow = {
  id: string;
  createdAt: string;
  rating: 1 | -1;
  mode: string | null;
  query: string;
  answer: string;
};

type Stats = { days: Day[]; feedback: FeedbackRow[]; ratings: { up?: number; down?: number } };

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '–');
const secs = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);

/** A disliked answer as a dataset.jsonl line; key_facts are left for a human to fill in. */
const toEvalCase = (f: FeedbackRow) =>
  JSON.stringify({ id: `feedback-${f.id}`, bucket: 'factual', query: f.query, key_facts: [], should_refuse: false });

const AdminPage = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');

  useEffect(() => {
    (async () => {
      const session = isSupabaseConfigured ? (await supabase.auth.getSession()).data.session : null;
      if (!session) throw new Error('Sign in with an admin account to see this page.');
      const response = await fetch(`${API_BASE_URL}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Could not load stats (${response.status})`);
      }
      setStats(await response.json());
    })().catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load stats'));
  }, []);

  const totals = (stats?.days ?? []).reduce(
    (t, d) => ({ requests: t.requests + d.requests, errors: t.errors + d.errors, fallbacks: t.fallbacks + d.fallbacks, cacheHits: t.cacheHits + (d.cacheHits ?? 0), deep: t.deep + d.deep }),
    { requests: 0, errors: 0, fallbacks: 0, cacheHits: 0, deep: 0 },
  );
  const up = stats?.ratings.up ?? 0;
  const down = stats?.ratings.down ?? 0;

  const copy = async (f: FeedbackRow) => {
    await navigator.clipboard.writeText(toEvalCase(f));
    setCopiedId(f.id);
  };

  return (
    <main className="evals-page">
      <header className="evals-header">
        <Link className="evals-back" to="/">← Back to Gaminai</Link>
        <p className="eyebrow">Admin</p>
        <h1>Operations</h1>
        <p className="evals-lede">Every AI request from the last 14 days, and what users thought of the answers.</p>
      </header>

      {error ? <p className="form-error">{error}</p> : null}
      {!stats && !error ? <p className="evals-muted">Loading…</p> : null}

      {stats ? (
        <>
          <section aria-labelledby="ops-title" className="evals-section">
            <h2 id="ops-title">Last 14 days</h2>
            <dl className="evals-stats">
              <div><dt>Requests</dt><dd>{totals.requests}</dd><p>Quick and deep answers</p></div>
              <div><dt>Error rate</dt><dd>{pct(totals.errors, totals.requests)}</dd><p>Requests that ended without an answer</p></div>
              <div><dt>Fallback rate</dt><dd>{pct(totals.fallbacks, totals.requests)}</dd><p>Answered by a backup model</p></div>
              <div><dt>Cache hit rate</dt><dd>{pct(totals.cacheHits, totals.requests)}</dd><p>Answered from the semantic cache</p></div>
              <div><dt>Deep research share</dt><dd>{pct(totals.deep, totals.requests)}</dd><p>Requests in deep mode</p></div>
              <div><dt>Thumbs up</dt><dd>{pct(up, up + down)}</dd><p>{up} up · {down} down</p></div>
            </dl>
            <div className="evals-table-wrap">
              <table className="evals-table">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Requests</th>
                    <th scope="col">p50</th>
                    <th scope="col">p95</th>
                    <th scope="col">Tokens / answer</th>
                    <th scope="col">Errors</th>
                    <th scope="col">Fallbacks</th>
                    <th scope="col">Deep</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats.days].reverse().map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{new Date(d.day).toLocaleDateString()}</th>
                      <td>{d.requests}</td>
                      <td>{secs(d.p50Ms)}</td>
                      <td>{secs(d.p95Ms)}</td>
                      <td>{d.avgTokens?.toLocaleString() ?? '–'}</td>
                      <td>{d.errors}</td>
                      <td>{d.fallbacks}</td>
                      <td>{d.deep}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="feedback-title" className="evals-section">
            <h2 id="feedback-title">Recent feedback</h2>
            <p className="evals-muted">Copy a disliked answer as an eval case, add its key facts, and append it to evals/dataset.jsonl.</p>
            <div className="evals-table-wrap">
              <table className="evals-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Rating</th>
                    <th scope="col">Question</th>
                    <th scope="col">Answer</th>
                    <th scope="col">Eval case</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.feedback.map((f) => (
                    <tr key={f.id}>
                      <td>{new Date(f.createdAt).toLocaleString()}</td>
                      <td>{f.rating === 1 ? 'Up' : 'Down'}{f.mode === 'deep' ? ' · deep' : ''}</td>
                      <th scope="row">{f.query}</th>
                      <td title={f.answer}>{f.answer.slice(0, 160)}{f.answer.length > 160 ? '…' : ''}</td>
                      <td>
                        {f.rating === -1 ? (
                          <button className="ghost-button" onClick={() => void copy(f)} type="button">
                            {copiedId === f.id ? 'Copied' : 'Copy'}
                          </button>
                        ) : null}
                      </td>
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

export default AdminPage;
