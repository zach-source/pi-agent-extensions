import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import initExtension from "./graphiti.js";

// ---------------------------------------------------------------------------
// Mock factories (same pattern as heartbeat.test.ts / bmad.test.ts)
// ---------------------------------------------------------------------------

function createMockExtensionAPI() {
  const handlers = new Map<string, Function[]>();
  const tools: Array<{ name: string; [k: string]: any }> = [];
  const commands = new Map<
    string,
    { description: string; handler: Function }
  >();

  const api = {
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool(def: any) {
      tools.push(def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };

  return {
    api,
    async emit(event: string, ...args: any[]) {
      const fns = handlers.get(event) ?? [];
      for (const fn of fns) await fn(...args);
    },
    getTool(name: string) {
      return tools.find((t) => t.name === name);
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    get tools() {
      return tools;
    },
    get commands() {
      return commands;
    },
  };
}

function createMockContext(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    cwd: overrides.cwd ?? "/tmp/test-project",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

interface MockResponseOpts {
  status?: number;
  headers?: Record<string, string>;
  body: string | Record<string, unknown>;
  contentType?: string;
}

function createMockResponse(opts: MockResponseOpts) {
  const status = opts.status ?? 200;
  const ct = opts.contentType ?? "application/json";
  const allHeaders: Record<string, string> = {
    "content-type": ct,
    ...(opts.headers || {}),
  };
  const headersMap = new Map(
    Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const bodyStr =
    typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headersMap.get(key.toLowerCase()) ?? null,
    },
    text: vi.fn().mockResolvedValue(bodyStr),
  };
}

/** Standard MCP session initialization responses (initialize + notifications/initialized). */
function mcpInitResponses(sid = "test-session-123") {
  return [
    createMockResponse({
      headers: { "mcp-session-id": sid },
      body: {
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: "2025-03-26", capabilities: {} },
      },
    }),
    createMockResponse({
      status: 202,
      headers: { "mcp-session-id": sid },
      body: "",
    }),
  ];
}

/** Successful MCP tool call response. */
function mcpToolResponse(
  content: Array<{ type: string; text?: string }>,
  isError = false,
) {
  return createMockResponse({
    body: { jsonrpc: "2.0", id: 1, result: { content, isError } },
  });
}

/** RPC error response. */
function mcpErrorResponse(message: string, code = -32000) {
  return createMockResponse({
    body: { jsonrpc: "2.0", id: 1, error: { code, message } },
  });
}

/**
 * Set up fetch mock with session-init handshake followed by tool responses.
 * Returns the mock for call inspection.
 */
function setupFetchMock(
  toolResponses: ReturnType<typeof createMockResponse>[],
) {
  const responses = [...mcpInitResponses(), ...toolResponses];
  let callIndex = 0;
  const fetchMock = vi.fn(async () => {
    if (callIndex < responses.length) return responses[callIndex++];
    throw new Error("Connection refused");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graphiti extension", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    // Reset module-level session state
    await mock.emit("session_start");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Registration ---

  describe("registration", () => {
    it("registers 3 tools", () => {
      expect(mock.tools).toHaveLength(3);
      expect(mock.getTool("graphiti_search")).toBeDefined();
      expect(mock.getTool("graphiti_add")).toBeDefined();
      expect(mock.getTool("graphiti_status")).toBeDefined();
    });

    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("graphiti-search")).toBeDefined();
      expect(mock.getCommand("graphiti-context")).toBeDefined();
    });

    it("registers session_start event handler", () => {
      const fresh = createMockExtensionAPI();
      initExtension(fresh.api as any);
      // Verify handler was registered (tools/commands also confirm init ran)
      expect(fresh.tools).toHaveLength(3);
      expect(fresh.commands.size).toBe(2);
    });

    it("tools have correct labels and descriptions", () => {
      const search = mock.getTool("graphiti_search")!;
      expect(search.label).toBe("Graphiti Search");
      expect(search.description).toContain("knowledge graph");

      const add = mock.getTool("graphiti_add")!;
      expect(add.label).toBe("Graphiti Add");
      expect(add.description).toContain("Store a memory");

      const status = mock.getTool("graphiti_status")!;
      expect(status.label).toBe("Graphiti Status");
      expect(status.description).toContain("healthy");
    });
  });

  // --- graphiti_search tool ---

  describe("graphiti_search tool", () => {
    it("searches nodes only", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Node: ProjectX" }]),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "project context", mode: "nodes" },
        undefined,
        vi.fn(),
      );

      expect(result.content[0].text).toContain("## Nodes");
      expect(result.content[0].text).toContain("Node: ProjectX");

      // Verify the MCP tool name used
      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.name).toBe("search_nodes");
    });

    it("searches facts only", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Fact: X uses Y" }]),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "relationships", mode: "facts" },
        undefined,
        vi.fn(),
      );

      expect(result.content[0].text).toContain("## Facts");
      expect(result.content[0].text).toContain("Fact: X uses Y");

      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.name).toBe("search_memory_facts");
    });

    it("searches both nodes and facts", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Node result" }]),
        mcpToolResponse([{ type: "text", text: "Fact result" }]),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "everything", mode: "both" },
        undefined,
        vi.fn(),
      );

      const text = result.content[0].text;
      expect(text).toContain("## Nodes");
      expect(text).toContain("Node result");
      expect(text).toContain("## Facts");
      expect(text).toContain("Fact result");
    });

    it("passes group filter when provided", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "filtered" }]),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      await tool.execute(
        "call-1",
        { query: "test", mode: "nodes", group: "my-group" },
        undefined,
        vi.fn(),
      );

      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.arguments.group_ids).toEqual(["my-group"]);
    });

    it("calls onUpdate with progress messages", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "nodes" }]),
        mcpToolResponse([{ type: "text", text: "facts" }]),
      ]);

      const onUpdate = vi.fn();
      const tool = mock.getTool("graphiti_search")!;
      await tool.execute(
        "call-1",
        { query: "test", mode: "both" },
        undefined,
        onUpdate,
      );

      expect(onUpdate).toHaveBeenCalledTimes(2);
      expect(onUpdate.mock.calls[0][0].content[0].text).toBe(
        "Searching nodes...",
      );
      expect(onUpdate.mock.calls[1][0].content[0].text).toBe(
        "Searching facts...",
      );
    });

    it("returns connection error when server is down", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Connection refused")),
      );

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "test", mode: "nodes" },
        undefined,
        vi.fn(),
      );

      expect(result.content[0].text).toContain("Cannot connect");
    });

    it("returns early on node search RPC error", async () => {
      setupFetchMock([mcpErrorResponse("search_nodes failed")]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "test", mode: "nodes" },
        undefined,
        vi.fn(),
      );

      expect(result.content[0].text).toContain("RPC error");
      expect(result.content[0].text).toContain("search_nodes failed");
    });

    it("returns early on fact search RPC error in both mode", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "nodes ok" }]),
        mcpErrorResponse("facts failed"),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "test", mode: "both" },
        undefined,
        vi.fn(),
      );

      expect(result.content[0].text).toContain("RPC error");
      expect(result.content[0].text).toContain("facts failed");
    });

    it("handles tool-level isError flag", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Tool error occurred" }], true),
      ]);

      const tool = mock.getTool("graphiti_search")!;
      const result = await tool.execute(
        "call-1",
        { query: "test", mode: "nodes" },
        undefined,
        vi.fn(),
      );

      // isError from callTool causes early return in search
      expect(result.content[0].text).toContain("Tool error occurred");
    });
  });

  // --- graphiti_add tool ---

  describe("graphiti_add tool", () => {
    it("adds memory with required params", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Episode added successfully" }]),
      ]);

      const tool = mock.getTool("graphiti_add")!;
      const result = await tool.execute("call-1", {
        name: "Fix: YAML parse error",
        body: "The error was caused by...",
        source: "text",
      });

      expect(result.content[0].text).toBe("Episode added successfully");

      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.name).toBe("add_memory");
      expect(toolCallBody.params.arguments.name).toBe("Fix: YAML parse error");
      expect(toolCallBody.params.arguments.episode_body).toBe(
        "The error was caused by...",
      );
      expect(toolCallBody.params.arguments.source).toBe("text");
      expect(toolCallBody.params.arguments.source_description).toBe(
        "pi extension",
      );
    });

    it("includes optional group and description", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "added" }]),
      ]);

      const tool = mock.getTool("graphiti_add")!;
      await tool.execute("call-1", {
        name: "Config: K8s cluster",
        body: "cluster info...",
        source: "json",
        description: "infrastructure context",
        group: "infra-group",
      });

      const args = JSON.parse(fetchMock.mock.calls[2][1].body).params.arguments;
      expect(args.source_description).toBe("infrastructure context");
      expect(args.group_id).toBe("infra-group");
    });

    it("uses default description when not provided", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "added" }]),
      ]);

      const tool = mock.getTool("graphiti_add")!;
      await tool.execute("call-1", {
        name: "test",
        body: "test",
        source: "text",
      });

      const args = JSON.parse(fetchMock.mock.calls[2][1].body).params.arguments;
      expect(args.source_description).toBe("pi extension");
    });

    it("handles connection failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Connection refused")),
      );

      const tool = mock.getTool("graphiti_add")!;
      const result = await tool.execute("call-1", {
        name: "test",
        body: "test",
        source: "text",
      });

      expect(result.content[0].text).toContain("Cannot connect");
    });
  });

  // --- graphiti_status tool ---

  describe("graphiti_status tool", () => {
    it("returns server status", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Graphiti server is healthy" }]),
      ]);

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toBe("Graphiti server is healthy");
    });

    it("returns error when server is down", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      );

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("Cannot connect");
    });

    it("calls get_status MCP tool", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "ok" }]),
      ]);

      const tool = mock.getTool("graphiti_status")!;
      await tool.execute("call-1", {});

      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.name).toBe("get_status");
    });
  });

  // --- /graphiti-search command ---

  describe("/graphiti-search command", () => {
    it("warns when no query provided", async () => {
      const ctx = createMockContext();
      const cmd = mock.getCommand("graphiti-search")!;
      await cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });

    it("searches and sends results to LLM", async () => {
      setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Found: ProjectX node" }]),
      ]);

      const ctx = createMockContext();
      const cmd = mock.getCommand("graphiti-search")!;
      await cmd.handler("project context", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Search results for: project context"),
        "info",
      );
      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "graphiti-search",
          content: "Found: ProjectX node",
        }),
      );
    });

    it("shows error notification on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));

      const ctx = createMockContext();
      const cmd = mock.getCommand("graphiti-search")!;
      await cmd.handler("test query", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Cannot connect"),
        "error",
      );
    });
  });

  // --- /graphiti-context command ---

  describe("/graphiti-context command", () => {
    it("uses project name from cwd", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "Context data..." }]),
      ]);

      const ctx = createMockContext({ cwd: "/home/user/my-project" });
      const cmd = mock.getCommand("graphiti-context")!;
      await cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Loading context for: my-project"),
        "info",
      );

      // Verify search query includes project name
      const toolCallBody = JSON.parse(fetchMock.mock.calls[2][1].body);
      expect(toolCallBody.params.arguments.query).toBe("my-project context");

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "graphiti-context",
          content: expect.stringContaining("my-project"),
        }),
        { triggerTurn: false },
      );
    });

    it("sends context with triggerTurn: false", async () => {
      setupFetchMock([mcpToolResponse([{ type: "text", text: "data" }])]);

      const ctx = createMockContext({ cwd: "/tmp/proj" });
      const cmd = mock.getCommand("graphiti-context")!;
      await cmd.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(expect.anything(), {
        triggerTurn: false,
      });
    });

    it("shows error on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));

      const ctx = createMockContext({ cwd: "/home/user/proj" });
      const cmd = mock.getCommand("graphiti-context")!;
      await cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Cannot connect"),
        "error",
      );
      expect(mock.api.sendMessage).not.toHaveBeenCalled();
    });
  });

  // --- Session management ---

  describe("session management", () => {
    it("reuses session on subsequent calls", async () => {
      const responses = [
        ...mcpInitResponses(),
        mcpToolResponse([{ type: "text", text: "first" }]),
        mcpToolResponse([{ type: "text", text: "second" }]),
      ];
      let callIndex = 0;
      const fetchMock = vi.fn(async () => responses[callIndex++]);
      vi.stubGlobal("fetch", fetchMock);

      const tool = mock.getTool("graphiti_status")!;

      await tool.execute("call-1", {});
      expect(fetchMock).toHaveBeenCalledTimes(3); // init + notify + tool

      await tool.execute("call-2", {});
      expect(fetchMock).toHaveBeenCalledTimes(4); // +1 tool (session reused)
    });

    it("resets session on session_start event", async () => {
      const responses = [
        ...mcpInitResponses(),
        mcpToolResponse([{ type: "text", text: "first" }]),
        ...mcpInitResponses("new-session"),
        mcpToolResponse([{ type: "text", text: "second" }]),
      ];
      let callIndex = 0;
      const fetchMock = vi.fn(async () => responses[callIndex++]);
      vi.stubGlobal("fetch", fetchMock);

      const tool = mock.getTool("graphiti_status")!;
      await tool.execute("call-1", {});
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Reset session via event
      await mock.emit("session_start");

      await tool.execute("call-2", {});
      expect(fetchMock).toHaveBeenCalledTimes(6); // re-init required
    });

    it("resets session on tool call network error", async () => {
      const responses = [...mcpInitResponses()];
      let callIndex = 0;
      const fetchMock = vi.fn(async () => {
        if (callIndex < responses.length) return responses[callIndex++];
        throw new Error("Network error");
      });
      vi.stubGlobal("fetch", fetchMock);

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("Error: Network error");
    });

    it("sends session ID header after init", async () => {
      const fetchMock = setupFetchMock([
        mcpToolResponse([{ type: "text", text: "ok" }]),
      ]);

      const tool = mock.getTool("graphiti_status")!;
      await tool.execute("call-1", {});

      // 3rd call (tool call) should include session header
      const toolCallHeaders = fetchMock.mock.calls[2][1].headers;
      expect(toolCallHeaders["Mcp-Session-Id"]).toBe("test-session-123");
    });

    it("handles SSE responses during init", async () => {
      const sseData = JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: "2025-03-26" },
      });
      const sseBody = `event: message\ndata: ${sseData}\n\n`;

      const responses = [
        createMockResponse({
          headers: { "mcp-session-id": "sse-session" },
          contentType: "text/event-stream",
          body: sseBody,
        }),
        createMockResponse({ status: 202, body: "" }),
        mcpToolResponse([{ type: "text", text: "via SSE" }]),
      ];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toBe("via SSE");
    });

    it("handles HTTP error during init", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createMockResponse({
            status: 500,
            body: "Internal Server Error",
          }),
        ),
      );

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("Cannot connect");
    });

    it("handles init RPC error response", async () => {
      const responses = [
        createMockResponse({
          body: {
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32600, message: "Bad request" },
          },
        }),
      ];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const tool = mock.getTool("graphiti_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("Cannot connect");
    });
  });
});
