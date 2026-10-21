import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const REPO_URL = 'https://github.com/MadhavBhanot/Gamanai';

/** Client config for the stdio MCP server in Backend/mcp.ts (same shape for Claude Desktop and Cursor). */
const mcpConfig = (repoPath: string) => {
  const backend = `${repoPath.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/') || 'C:/path/to/Gamanai'}/Backend`;
  return JSON.stringify(
    {
      mcpServers: {
        gaminai: {
          command: 'node',
          args: [`${backend}/node_modules/ts-node/dist/bin.js`, '--transpile-only', `${backend}/mcp.ts`],
        },
      },
    },
    null,
    2,
  );
};

/** Native <dialog>: showModal() gives the backdrop, focus trap and Esc-to-close. */
const McpSetupModal = ({ onClose }: { onClose: () => void }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [repoPath, setRepoPath] = useState('');
  const [copied, setCopied] = useState(false);
  const config = mcpConfig(repoPath);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  // Unmount on every close path directly; the dialog's own close event isn't reliable in every browser state
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (non-https or denied): the config stays selectable in the box
    }
  };

  return (
    <dialog
      aria-labelledby="mcp-title"
      className="mcp-dialog"
      onCancel={(event) => {
        event.preventDefault(); // Esc
        close();
      }}
      onClick={(event) => event.target === dialogRef.current && close()}
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="mcp-dialog-body">
        <header className="mcp-dialog-head">
          <div>
            <p className="eyebrow">MCP server</p>
            <h2 id="mcp-title">Use Gaminai from Claude Desktop or Cursor</h2>
          </div>
          <button aria-label="Close" className="mcp-close" onClick={close} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <p className="mcp-lede">
          Gaminai runs as a local MCP tool, <code>gaminai_research(query, mode)</code>: your assistant asks a question and
          gets back a cited answer with numbered sources. Quick mode takes a few seconds; Deep mode plans several
          searches.
        </p>

        <ol className="mcp-steps">
          <li>
            Clone the repo and install the backend:{' '}
            <a href={REPO_URL} rel="noreferrer" target="_blank">
              {REPO_URL.replace('https://', '')}
            </a>
            , then <code>cd Backend &amp;&amp; npm install</code>.
          </li>
          <li>
            Copy <code>Backend/.env.example</code> to <code>Backend/.env</code> and add your keys (Tavily, Gemini or
            Groq, and the database URL). The server reads them from there, so it works from any folder.
          </li>
          <li>
            <label htmlFor="mcp-path">Where did you clone it?</label>
            <input
              autoComplete="off"
              id="mcp-path"
              onChange={(event) => setRepoPath(event.target.value)}
              placeholder="C:/path/to/Gamanai"
              spellCheck={false}
              type="text"
              value={repoPath}
            />
          </li>
          <li>
            Add this to <code>claude_desktop_config.json</code> (Claude Desktop: Settings, Developer, Edit config) or{' '}
            <code>.cursor/mcp.json</code>, then restart the app.
          </li>
        </ol>

        <div className="mcp-config">
          <button className="mcp-copy" onClick={() => void copy()} type="button">
            {copied ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <pre>
            <code>{config}</code>
          </pre>
        </div>
      </div>
    </dialog>
  );
};

export default McpSetupModal;
