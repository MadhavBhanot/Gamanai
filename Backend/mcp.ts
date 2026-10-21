/**
 * Gaminai as an MCP server (stdio), so Claude Desktop, Cursor or any MCP client can call the research pipeline.
 * Client config: command "node", args ["<Backend>/node_modules/ts-node/dist/bin.js", "--transpile-only", "<Backend>/mcp.ts"]
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// stdout is the protocol channel: route every log line to stderr
console.log = console.error;

/** Answer text with its [n] markers, then the numbered sources they point to. */
export function formatToolResult(answer: string, contexts: { url: string; title: string }[]) {
  const sources = contexts.map((c, i) => `[${i + 1}] ${c.title} - ${c.url}`).join("\n");
  return sources ? `${answer}\n\nSources:\n${sources}` : answer;
}

async function main() {
  // MCP clients start us from their own working directory, so load .env by path
  // require(), not import(): ts-node started from another folder leaves import() as native ESM, which can't load .ts
  (require("dotenv") as typeof import("dotenv")).config({ path: `${__dirname}/.env`, quiet: true });
  // Loaded after the stdout guard and .env, since these modules read keys and log on import
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as typeof import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js") as typeof import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = require("zod") as typeof import("zod");
  const { prepareAnswer, generateAnswer } = require("./llm/answer") as typeof import("./llm/answer");
  const { prepareDeepAnswer } = require("./llm/research") as typeof import("./llm/research");
  const { parseAnswerSections } = require("./evals/metrics") as typeof import("./evals/metrics");

  const server = new McpServer({ name: "gaminai", version: "1.0.0" });
  server.registerTool(
    "gaminai_research",
    {
      title: "Gaminai web research",
      description:
        "Search the web and answer with numbered citations [n] to the listed sources. " +
        "mode 'quick' does one search (a few seconds); 'deep' plans several searches for multi-part questions (up to a minute).",
      inputSchema: {
        query: z.string().min(1).max(2000).describe("The question to research"),
        mode: z.enum(["quick", "deep"]).default("quick"),
      },
    },
    async ({ query, mode }): Promise<CallToolResult> => {
      try {
        const prepared = mode === "deep" ? await prepareDeepAnswer(query) : await prepareAnswer(query);
        const result = await generateAnswer(prepared.messages);
        const { answer } = parseAnswerSections(result.content);
        return { content: [{ type: "text", text: formatToolResult(answer || result.content, prepared.contexts) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Research failed: ${(error as Error)?.message ?? error}` }] };
      }
    },
  );
  await server.connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
