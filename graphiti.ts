/**
 * Graphiti Knowledge Graph Extension for Pi
 *
 * Provides LLM-callable tools for interacting with the Graphiti
 * temporal knowledge graph via MCP-over-HTTP (JSON-RPC 2.0).
 *
 * Tools:
 *   graphiti_search  - Search entity nodes and/or facts
 *   graphiti_add     - Store a memory/episode
 *   graphiti_status  - Check server health
 *
 * Server must be running:
 *   launchctl list | rg 'com\\.claude\\.(graphiti|neo4j)'
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const GRAPHITI_URL = "http://127.0.0.1:51847/mcp/";
const PROTOCOL_VERSION = "2025-03-26";

// --- MCP-over-HTTP client ---

let sessionId: string | null = null;
let sessionInitialized = false;

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

function jsonrpc(
  method: string,
  params?: Record<string, unknown>,
  reqId: number = 1,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: reqId,
    method,
  };
  if (params) payload.params = params;
  return payload;
}

function parseSSE(body: string): JsonRpcResponse {
  let lastData: string | null = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("data: ")) lastData = line.slice(6);
  }
  if (lastData) return JSON.parse(lastData) as JsonRpcResponse;
  return {
    jsonrpc: "2.0",
    id: 0,
    error: { code: -1, message: "Empty SSE stream" },
  };
}

async function mcpPost(payload: Record<string, unknown>): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const resp = await fetch(GRAPHITI_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const sid = resp.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }

  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text();

  if (ct.includes("text/event-stream")) {
    return parseSSE(text);
  }

  // notifications/initialized returns 202 with an empty body.
  if (!text.trim()) {
    return {
      jsonrpc: "2.0",
      id: typeof payload.id === "number" ? (payload.id as number) : 0,
      result: {},
    };
  }

  return JSON.parse(text) as JsonRpcResponse;
}

async function ensureSession(): Promise<boolean> {
  if (sessionId && sessionInitialized) return true;

  sessionId = null;
  sessionInitialized = false;

  try {
    const initResp = await mcpPost(
      jsonrpc(
        "initialize",
        {
          clientInfo: { name: "pi-graphiti-ext", version: "1.0" },
          capabilities: {},
          protocolVersion: PROTOCOL_VERSION,
        },
        0,
      ),
    );

    if (initResp.error) return false;

    // IMPORTANT: Graphiti requires this handshake step, otherwise tool calls fail
    // with "Invalid request parameters".
    await mcpPost({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    sessionInitialized = true;
    return true;
  } catch {
    return false;
  }
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  if (!(await ensureSession())) {
    return {
      text: "Cannot connect to Graphiti server. Check: launchctl list | rg 'com.claude.(graphiti|neo4j)'",
      isError: true,
    };
  }

  try {
    const resp = await mcpPost(jsonrpc("tools/call", { name, arguments: args }));

    if (resp.error) {
      return { text: `RPC error: ${resp.error.message}`, isError: true };
    }

    const result = resp.result || {};
    const texts = (result.content || [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    return {
      text: texts.join("\n") || JSON.stringify(result, null, 2),
      isError: !!result.isError,
    };
  } catch (e) {
    sessionId = null;
    sessionInitialized = false;
    return {
      text: `Error: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

// --- Tool parameter schemas ---

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query (natural language)" }),
  mode: StringEnum(["nodes", "facts", "both"] as const, {
    description: "Search mode: nodes (entities), facts (relationships), or both",
  }),
  group: Type.Optional(
    Type.String({ description: "Filter by group ID (default: all groups)" }),
  ),
});

type SearchInput = Static<typeof SearchParams>;

const AddParams = Type.Object({
  name: Type.String({
    description: "Episode title (e.g., 'Fix: YAML parse error')",
  }),
  body: Type.String({ description: "Episode content with full details" }),
  source: StringEnum(["text", "json", "message"] as const, {
    description: "Content type of the episode body",
  }),
  description: Type.Optional(
    Type.String({
      description: "Source description (e.g., 'failure-to-success learning')",
    }),
  ),
  group: Type.Optional(
    Type.String({
      description: "Group ID for this memory (recommended to avoid mixing projects)",
    }),
  ),
});

type AddInput = Static<typeof AddParams>;

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    sessionId = null;
    sessionInitialized = false;
  });

  // --- graphiti_search tool ---
  pi.registerTool({
    name: "graphiti_search",
    label: "Graphiti Search",
    description:
      "Search the Graphiti knowledge graph for entity nodes, facts (relationships), or both. " +
      "Use to find previous solutions, infrastructure context, project patterns, and cross-session learnings. " +
      "Try searching before starting complex debugging or unfamiliar tasks.",
    parameters: SearchParams,

    async execute(_toolCallId, params: SearchInput, _signal, onUpdate) {
      const results: string[] = [];

      if (params.mode === "nodes" || params.mode === "both") {
        onUpdate?.({ content: [{ type: "text", text: "Searching nodes..." }] });
        const args: Record<string, unknown> = { query: params.query };
        if (params.group) args.group_ids = [params.group];
        const r = await callTool("search_nodes", args);
        if (r.isError)
          return { content: [{ type: "text", text: r.text }], details: {} };
        results.push(`## Nodes\n${r.text}`);
      }

      if (params.mode === "facts" || params.mode === "both") {
        onUpdate?.({ content: [{ type: "text", text: "Searching facts..." }] });
        const args: Record<string, unknown> = { query: params.query };
        if (params.group) args.group_ids = [params.group];
        const r = await callTool("search_memory_facts", args);
        if (r.isError)
          return { content: [{ type: "text", text: r.text }], details: {} };
        results.push(`## Facts\n${r.text}`);
      }

      return {
        content: [
          { type: "text", text: results.join("\n\n") || "No results found." },
        ],
        details: {},
      };
    },
  });

  // --- graphiti_add tool ---
  pi.registerTool({
    name: "graphiti_add",
    label: "Graphiti Add",
    description:
      "Store a memory in the Graphiti knowledge graph. Use for: " +
      "failure-to-success learnings (what broke, why, how fixed), " +
      "infrastructure context (cluster configs, service endpoints), " +
      "tool/build configuration insights, and cross-session progress. " +
      "Name with prefixes like 'Fix:', 'Config:', 'Pattern:', 'Progress:'.",
    parameters: AddParams,

    async execute(_toolCallId, params: AddInput) {
      const args: Record<string, unknown> = {
        name: params.name,
        episode_body: params.body,
        source: params.source,
        source_description: params.description || "pi extension",
      };

      if (params.group) args.group_id = params.group;

      const r = await callTool("add_memory", args);
      return { content: [{ type: "text", text: r.text }], details: {} };
    },
  });

  // --- graphiti_status tool ---
  pi.registerTool({
    name: "graphiti_status",
    label: "Graphiti Status",
    description: "Check if the Graphiti knowledge graph server is running and healthy.",
    parameters: Type.Object({}),

    async execute() {
      const r = await callTool("get_status", {});
      return { content: [{ type: "text", text: r.text }], details: {} };
    },
  });

  // --- /graphiti-search command ---
  pi.registerCommand("graphiti-search", {
    description: "Search Graphiti knowledge graph",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Usage: /graphiti-search <query>", "warning");
        return;
      }
      const r = await callTool("search_nodes", { query: args });
      if (r.isError) {
        ctx.ui.notify(r.text, "error");
      } else {
        ctx.ui.notify(`Search results for: ${args}`, "info");
        // Feed results to the LLM
        pi.sendMessage({
          customType: "graphiti-search",
          content: r.text,
          display: true,
        });
      }
    },
  });

  // --- /graphiti-context command ---
  pi.registerCommand("graphiti-context", {
    description: "Load project context from Graphiti",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const projectName = cwd.split("/").pop() || "unknown";
      ctx.ui.notify(`Loading context for: ${projectName}`, "info");

      const r = await callTool("search_nodes", {
        query: `${projectName} context`,
      });
      if (r.isError) {
        ctx.ui.notify(r.text, "error");
        return;
      }

      pi.sendMessage(
        {
          customType: "graphiti-context",
          content: `## Project Context: ${projectName}\n\n${r.text}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
