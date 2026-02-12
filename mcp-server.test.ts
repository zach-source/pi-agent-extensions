import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import initExtension, {
  jsonrpc,
  parseSSE,
  expandEnvVars,
  inferType,
  normalizeConfig,
  toolName,
  formatStatus,
  formatToolList,
  connections,
  disconnectAll,
  loadConfig,
  saveConfig,
  HttpTransport,
  createTransport,
  registerMcpTools,
  OAuthProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  type McpServerConfig,
  type McpConnection,
  type McpTransport,
  type JsonRpcResponse,
  type OAuthTokens,
  type AuthServerMetadata,
} from "./mcp-server.js";

// ---------------------------------------------------------------------------
// Mock factories
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

function mcpToolsListResponse(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>,
) {
  return createMockResponse({
    body: { jsonrpc: "2.0", id: 1, result: { tools } },
  });
}

function mcpToolCallResponse(
  content: Array<{ type: string; text?: string }>,
  isError = false,
) {
  return createMockResponse({
    body: { jsonrpc: "2.0", id: 1, result: { content, isError } },
  });
}

function mcpErrorResponse(message: string, code = -32000) {
  return createMockResponse({
    body: { jsonrpc: "2.0", id: 1, error: { code, message } },
  });
}

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
// Mock transport for connection manager tests
// ---------------------------------------------------------------------------

function createMockTransport(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }> = [],
): McpTransport & { closed: boolean } {
  return {
    closed: false,
    async initialize(): Promise<JsonRpcResponse> {
      return {
        jsonrpc: "2.0",
        id: 0,
        result: { protocolVersion: "2025-03-26" },
      };
    },
    async request(method: string): Promise<JsonRpcResponse> {
      if (method === "tools/list") {
        return { jsonrpc: "2.0", id: 1, result: { tools } };
      }
      if (method === "ping") {
        return { jsonrpc: "2.0", id: 1, result: {} };
      }
      return { jsonrpc: "2.0", id: 1, result: {} };
    },
    async close() {
      this.closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp-server extension", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectAll();
  });

  // --- JSON-RPC Helpers ---

  describe("jsonrpc()", () => {
    it("builds a JSON-RPC envelope", () => {
      const msg = jsonrpc("tools/list", { cursor: "abc" }, 42);
      expect(msg).toEqual({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/list",
        params: { cursor: "abc" },
      });
    });

    it("omits params when not provided", () => {
      const msg = jsonrpc("ping", undefined, 1);
      expect(msg).not.toHaveProperty("params");
    });

    it("auto-increments id when not provided", () => {
      const a = jsonrpc("a");
      const b = jsonrpc("b");
      expect(typeof a.id).toBe("number");
      expect((b.id as number) > (a.id as number)).toBe(true);
    });
  });

  describe("parseSSE()", () => {
    it("extracts last data line", () => {
      const body =
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
      const result = parseSSE(body);
      expect(result.result).toEqual({});
    });

    it("returns error for empty SSE", () => {
      const result = parseSSE("");
      expect(result.error?.message).toBe("Empty SSE stream");
    });

    it("uses last data line when multiple present", () => {
      const body =
        'data: {"jsonrpc":"2.0","id":1,"result":{"first":true}}\ndata: {"jsonrpc":"2.0","id":1,"result":{"last":true}}\n';
      const result = parseSSE(body);
      expect(result.result).toEqual({ last: true });
    });
  });

  // --- Config Parsing ---

  describe("inferType()", () => {
    it("returns http for explicit type", () => {
      expect(inferType({ type: "http", url: "http://x" })).toBe("http");
    });

    it("returns stdio for explicit type", () => {
      expect(inferType({ type: "stdio", command: "node" })).toBe("stdio");
    });

    it("infers http from url field", () => {
      expect(inferType({ url: "http://example.com" })).toBe("http");
    });

    it("defaults to stdio for command field", () => {
      expect(inferType({ command: "npx", args: ["-y", "pkg"] })).toBe("stdio");
    });

    it("defaults to stdio for unknown", () => {
      expect(inferType({})).toBe("stdio");
    });
  });

  describe("normalizeConfig()", () => {
    it("normalizes Pi format (mcpServers wrapper)", () => {
      const result = normalizeConfig({
        mcpServers: {
          myserver: { type: "http", url: "http://x" },
        },
      });
      expect(result.mcpServers.myserver).toEqual(
        expect.objectContaining({ type: "http", url: "http://x" }),
      );
    });

    it("normalizes Claude flat format (stdio)", () => {
      const result = normalizeConfig({
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      });
      expect(result.mcpServers.context7).toEqual(
        expect.objectContaining({
          type: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        }),
      );
    });

    it("normalizes Claude flat format (http)", () => {
      const result = normalizeConfig({
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      });
      expect(result.mcpServers.github).toEqual(
        expect.objectContaining({
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
        }),
      );
    });

    it("skips non-object entries", () => {
      const result = normalizeConfig({
        valid: { command: "node" },
        invalid: "not an object" as any,
        alsoInvalid: null as any,
      });
      expect(Object.keys(result.mcpServers)).toEqual(["valid"]);
    });
  });

  describe("expandEnvVars()", () => {
    it("expands ${VAR} references", () => {
      process.env.TEST_TOKEN_MCP = "secret123";
      expect(expandEnvVars("Bearer ${TEST_TOKEN_MCP}")).toBe(
        "Bearer secret123",
      );
      delete process.env.TEST_TOKEN_MCP;
    });

    it("replaces missing vars with empty string", () => {
      expect(expandEnvVars("${NONEXISTENT_VAR_XYZ}")).toBe("");
    });

    it("leaves strings without vars unchanged", () => {
      expect(expandEnvVars("plain text")).toBe("plain text");
    });
  });

  // --- Config File I/O ---

  describe("loadConfig()", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-cfg-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("loads .mcp.json in Claude format", async () => {
      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({
          filesystem: { command: "npx", args: ["-y", "fs-server"] },
        }),
      );

      const config = await loadConfig(tmpDir);
      expect(config.mcpServers.filesystem).toEqual(
        expect.objectContaining({ type: "stdio", command: "npx" }),
      );
    });

    it("loads .pi/mcp.json in Pi format", async () => {
      await mkdir(join(tmpDir, ".pi"), { recursive: true });
      await writeFile(
        join(tmpDir, ".pi/mcp.json"),
        JSON.stringify({
          mcpServers: {
            remote: { type: "http", url: "http://example.com" },
          },
        }),
      );

      const config = await loadConfig(tmpDir);
      expect(config.mcpServers.remote).toEqual(
        expect.objectContaining({ type: "http", url: "http://example.com" }),
      );
    });

    it("prefers .mcp.json over .pi/mcp.json", async () => {
      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({ from_claude: { command: "a" } }),
      );
      await mkdir(join(tmpDir, ".pi"), { recursive: true });
      await writeFile(
        join(tmpDir, ".pi/mcp.json"),
        JSON.stringify({
          mcpServers: { from_pi: { type: "stdio", command: "b" } },
        }),
      );

      const config = await loadConfig(tmpDir);
      expect(config.mcpServers.from_claude).toBeDefined();
      expect(config.mcpServers.from_pi).toBeUndefined();
    });

    it("returns empty config when no files exist", async () => {
      const config = await loadConfig(tmpDir);
      expect(config.mcpServers).toEqual({});
    });
  });

  describe("saveConfig()", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-save-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("saves in Claude flat format when .mcp.json was loaded", async () => {
      // First load from .mcp.json to set activeConfigPath
      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({ existing: { command: "x" } }),
      );
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          myserver: {
            type: "stdio",
            command: "npx",
            args: ["-y", "pkg"],
          },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      // Claude format: no mcpServers wrapper, no type field for stdio
      expect(content.myserver).toBeDefined();
      expect(content.myserver.command).toBe("npx");
      expect(content.myserver.type).toBeUndefined();
      expect(content.mcpServers).toBeUndefined();
    });

    it("saves http server with type field in Claude format", async () => {
      await writeFile(join(tmpDir, ".mcp.json"), JSON.stringify({}));
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          api: { type: "http", url: "http://example.com" },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.api.type).toBe("http");
      expect(content.api.url).toBe("http://example.com");
    });

    it("saves in Pi format when .pi/mcp.json was loaded", async () => {
      await mkdir(join(tmpDir, ".pi"), { recursive: true });
      await writeFile(
        join(tmpDir, ".pi/mcp.json"),
        JSON.stringify({ mcpServers: {} }),
      );
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          myserver: { type: "stdio", command: "node" },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".pi/mcp.json"), "utf-8"),
      );
      expect(content.mcpServers.myserver).toBeDefined();
    });

    it("defaults to .mcp.json when no config loaded", async () => {
      // Load from non-existent dir to reset activeConfigPath
      await loadConfig(join(tmpDir, "nonexistent"));

      await saveConfig(tmpDir, {
        mcpServers: {
          test: { type: "stdio", command: "echo" },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.test.command).toBe("echo");
    });
  });

  // --- Tool Naming ---

  describe("toolName()", () => {
    it("creates mcp_server_tool format", () => {
      expect(toolName("graphiti", "search_nodes")).toBe(
        "mcp_graphiti_search_nodes",
      );
    });

    it("strips redundant server prefix from tool name", () => {
      expect(toolName("graphiti", "graphiti_search")).toBe(
        "mcp_graphiti_search",
      );
    });

    it("does not strip partial prefix matches", () => {
      expect(toolName("graph", "graphiti_search")).toBe(
        "mcp_graph_graphiti_search",
      );
    });
  });

  // --- HttpTransport ---

  describe("HttpTransport", () => {
    it("initializes with session handshake", async () => {
      const fetchMock = setupFetchMock([]);

      const transport = new HttpTransport("http://localhost:8080/mcp");
      const result = await transport.initialize();

      expect(result.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // First call: initialize
      const initBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(initBody.method).toBe("initialize");

      // Second call: notifications/initialized
      const notifyBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(notifyBody.method).toBe("notifications/initialized");
    });

    it("sends session ID header after init", async () => {
      setupFetchMock([
        createMockResponse({
          body: { jsonrpc: "2.0", id: 1, result: {} },
        }),
      ]);

      const transport = new HttpTransport("http://localhost:8080/mcp");
      await transport.initialize();
      await transport.request("tools/list");

      const lastCall = vi.mocked(fetch).mock.calls[2];
      expect(lastCall[1]!.headers).toHaveProperty(
        "Mcp-Session-Id",
        "test-session-123",
      );
    });

    it("passes custom headers", async () => {
      setupFetchMock([]);

      const transport = new HttpTransport("http://localhost:8080/mcp", {
        Authorization: "Bearer token123",
      });
      await transport.initialize();

      const initHeaders = vi.mocked(fetch).mock.calls[0][1]!.headers;
      expect(initHeaders).toHaveProperty("Authorization", "Bearer token123");
    });

    it("handles SSE responses", async () => {
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
      ];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const transport = new HttpTransport("http://localhost:8080/mcp");
      const result = await transport.initialize();

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ protocolVersion: "2025-03-26" });
    });

    it("returns error on init failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createMockResponse({
            body: {
              jsonrpc: "2.0",
              id: 0,
              error: { code: -1, message: "Bad request" },
            },
          }),
        ),
      );

      const transport = new HttpTransport("http://localhost:8080/mcp");
      const result = await transport.initialize();

      expect(result.error?.message).toBe("Bad request");
    });

    it("throws on HTTP error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createMockResponse({ status: 500, body: "Server Error" }),
        ),
      );

      const transport = new HttpTransport("http://localhost:8080/mcp");
      await expect(transport.initialize()).rejects.toThrow("HTTP 500");
    });

    it("clears session on close", async () => {
      setupFetchMock([]);
      const transport = new HttpTransport("http://localhost:8080/mcp");
      await transport.initialize();
      await transport.close();

      // After close, next init should not send session header
      setupFetchMock([]);
      await transport.initialize();
      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<
        string,
        string
      >;
      expect(headers["Mcp-Session-Id"]).toBeUndefined();
    });
  });

  // --- createTransport ---

  describe("createTransport()", () => {
    it("creates HttpTransport for http type", () => {
      const t = createTransport({ type: "http", url: "http://x" });
      expect(t).toBeInstanceOf(HttpTransport);
    });

    it("throws for http without url", () => {
      expect(() => createTransport({ type: "http" })).toThrow(
        "HTTP transport requires url",
      );
    });

    it("throws for stdio without command", () => {
      expect(() => createTransport({ type: "stdio" })).toThrow(
        "Stdio transport requires command",
      );
    });

    it("throws for unknown type", () => {
      expect(() => createTransport({ type: "websocket" as any })).toThrow(
        "Unknown transport type",
      );
    });
  });

  // --- Status Formatting ---

  describe("formatStatus()", () => {
    it("shows empty message when no connections", () => {
      const text = formatStatus();
      expect(text).toContain("No MCP servers configured");
    });

    it("shows connected server with tools", () => {
      connections.set("test-server", {
        name: "test-server",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [
          {
            name: "search",
            description: "Search stuff",
            inputSchema: { type: "object" },
          },
        ],
        connected: true,
      });

      const text = formatStatus();
      expect(text).toContain("test-server");
      expect(text).toContain("connected");
      expect(text).toContain("search");
      expect(text).toContain("1 tool(s)");
    });

    it("shows disconnected server with error", () => {
      connections.set("broken", {
        name: "broken",
        config: { type: "http", url: "http://x" },
        transport: createMockTransport(),
        tools: [],
        connected: false,
        error: "Connection refused",
      });

      const text = formatStatus();
      expect(text).toContain("broken");
      expect(text).toContain("disconnected");
      expect(text).toContain("Connection refused");
    });
  });

  describe("formatToolList()", () => {
    it("shows no tools when no connections", () => {
      expect(formatToolList()).toContain("No MCP servers connected");
    });

    it("lists tools grouped by server", () => {
      connections.set("srv", {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [
          {
            name: "tool_a",
            description: "Tool A",
            inputSchema: { type: "object" },
          },
          {
            name: "tool_b",
            description: "Tool B",
            inputSchema: { type: "object" },
          },
        ],
        connected: true,
      });

      const text = formatToolList();
      expect(text).toContain("mcp_srv_tool_a");
      expect(text).toContain("mcp_srv_tool_b");
      expect(text).toContain("Tool A");
    });

    it("skips disconnected servers", () => {
      connections.set("dead", {
        name: "dead",
        config: { type: "stdio", command: "x" },
        transport: createMockTransport(),
        tools: [
          {
            name: "t",
            description: "T",
            inputSchema: { type: "object" },
          },
        ],
        connected: false,
      });

      const text = formatToolList();
      expect(text).toContain("No tools available");
    });
  });

  // --- registerMcpTools ---

  describe("registerMcpTools()", () => {
    it("registers Pi tools for each MCP tool", () => {
      const mock = createMockExtensionAPI();
      const conn: McpConnection = {
        name: "myserver",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [
          {
            name: "do_thing",
            description: "Does a thing",
            inputSchema: {
              type: "object",
              properties: { arg: { type: "string" } },
            },
          },
        ],
        connected: true,
      };

      registerMcpTools(mock.api as any, conn);

      expect(mock.tools).toHaveLength(1);
      expect(mock.tools[0].name).toBe("mcp_myserver_do_thing");
      expect(mock.tools[0].label).toBe("myserver: do_thing");
      expect(mock.tools[0].description).toContain("[MCP: myserver]");
    });

    it("registered tool calls MCP server", async () => {
      const mock = createMockExtensionAPI();
      const transport = createMockTransport();
      transport.request = vi.fn(async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: "result data" }],
          isError: false,
        },
      }));

      const conn: McpConnection = {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [
          {
            name: "query",
            description: "Query",
            inputSchema: { type: "object" },
          },
        ],
        connected: true,
      };

      registerMcpTools(mock.api as any, conn);
      const tool = mock.getTool("mcp_srv_query")!;
      const result = await tool.execute("call-1", { q: "test" });

      expect(result.content[0].text).toBe("result data");
      expect(transport.request).toHaveBeenCalledWith("tools/call", {
        name: "query",
        arguments: { q: "test" },
      });
    });

    it("returns error when server disconnected", async () => {
      const mock = createMockExtensionAPI();
      const conn: McpConnection = {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [
          {
            name: "t",
            description: "T",
            inputSchema: { type: "object" },
          },
        ],
        connected: false,
      };

      registerMcpTools(mock.api as any, conn);
      const tool = mock.getTool("mcp_srv_t")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("not connected");
    });

    it("handles RPC error from tool call", async () => {
      const mock = createMockExtensionAPI();
      const transport = createMockTransport();
      transport.request = vi.fn(async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -1, message: "tool failed" },
      }));

      const conn: McpConnection = {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [
          {
            name: "t",
            description: "T",
            inputSchema: { type: "object" },
          },
        ],
        connected: true,
      };

      registerMcpTools(mock.api as any, conn);
      const result = await mock.getTool("mcp_srv_t")!.execute("c", {});

      expect(result.content[0].text).toContain("RPC error: tool failed");
    });

    it("marks server disconnected on transport error", async () => {
      const mock = createMockExtensionAPI();
      const transport = createMockTransport();
      transport.request = vi.fn(async () => {
        throw new Error("Network down");
      });

      const conn: McpConnection = {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [
          {
            name: "t",
            description: "T",
            inputSchema: { type: "object" },
          },
        ],
        connected: true,
      };

      registerMcpTools(mock.api as any, conn);
      const result = await mock.getTool("mcp_srv_t")!.execute("c", {});

      expect(result.content[0].text).toContain("Error: Network down");
      expect(conn.connected).toBe(false);
    });
  });

  // --- Extension Registration ---

  describe("registration", () => {
    it("registers 1 tool and 5 commands", () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      expect(mock.getTool("mcp_manage")).toBeDefined();
      expect(mock.commands.size).toBe(5);
      expect(mock.getCommand("mcp")).toBeDefined();
      expect(mock.getCommand("mcp-list")).toBeDefined();
      expect(mock.getCommand("mcp-add")).toBeDefined();
      expect(mock.getCommand("mcp-remove")).toBeDefined();
      expect(mock.getCommand("mcp-test")).toBeDefined();
    });
  });

  // --- mcp_manage tool ---

  describe("mcp_manage tool", () => {
    let mock: ReturnType<typeof createMockExtensionAPI>;

    beforeEach(() => {
      mock = createMockExtensionAPI();
      initExtension(mock.api as any);
    });

    it("list action returns server status", async () => {
      connections.set("s1", {
        name: "s1",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [],
        connected: true,
      });

      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", { action: "list" });

      expect(result.content[0].text).toContain("s1");
      expect(result.details.servers).toHaveLength(1);
    });

    it("connect action requires server_name", async () => {
      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", { action: "connect" });
      expect(result.content[0].text).toContain("server_name required");
    });

    it("disconnect action requires server_name", async () => {
      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", { action: "disconnect" });
      expect(result.content[0].text).toContain("server_name required");
    });

    it("disconnect action removes server", async () => {
      connections.set("s1", {
        name: "s1",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [],
        connected: true,
      });

      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", {
        action: "disconnect",
        server_name: "s1",
      });

      expect(result.content[0].text).toContain('Disconnected "s1"');
      expect(connections.has("s1")).toBe(false);
    });

    it("test action pings server", async () => {
      const transport = createMockTransport();
      transport.request = vi.fn(async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      }));
      connections.set("s1", {
        name: "s1",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [],
        connected: true,
      });

      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", {
        action: "test",
        server_name: "s1",
      });

      expect(result.content[0].text).toContain("responsive");
    });

    it("test action reports error on failure", async () => {
      const transport = createMockTransport();
      transport.request = vi.fn(async () => {
        throw new Error("timeout");
      });
      connections.set("s1", {
        name: "s1",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [],
        connected: true,
      });

      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", {
        action: "test",
        server_name: "s1",
      });

      expect(result.content[0].text).toContain("test failed");
    });

    it("unknown action returns error", async () => {
      const tool = mock.getTool("mcp_manage")!;
      const result = await tool.execute("c", { action: "explode" });
      expect(result.content[0].text).toContain("Unknown action");
    });
  });

  // --- Slash Commands ---

  describe("/mcp command", () => {
    it("sends status message", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext();
      await mock.getCommand("mcp")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "mcp-status",
          display: true,
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("/mcp-list command", () => {
    it("sends tools list message", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext();
      await mock.getCommand("mcp-list")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "mcp-tools",
          display: true,
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("/mcp-add command", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-add-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("warns on empty args", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-add")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });

    it("warns on too few args", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-add")!.handler("name stdio", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });

    it("rejects invalid type", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-add")!.handler("name websocket ws://x", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Invalid type"),
        "error",
      );
    });

    it("adds stdio server to config", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      // Pre-create empty .mcp.json so loadConfig finds it
      await writeFile(join(tmpDir, ".mcp.json"), "{}");

      const ctx = createMockContext({ cwd: tmpDir });
      await mock
        .getCommand("mcp-add")!
        .handler("fs stdio npx -y @mcp/fs /home", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Added MCP server "fs"'),
        "info",
      );

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.fs.command).toBe("npx");
      expect(content.fs.args).toEqual(["-y", "@mcp/fs", "/home"]);
    });

    it("adds http server to config", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      await writeFile(join(tmpDir, ".mcp.json"), "{}");

      const ctx = createMockContext({ cwd: tmpDir });
      await mock
        .getCommand("mcp-add")!
        .handler("api http https://mcp.example.com", ctx);

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.api.type).toBe("http");
      expect(content.api.url).toBe("https://mcp.example.com");
    });
  });

  describe("/mcp-remove command", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-rm-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("warns on empty args", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-remove")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });

    it("warns when server not in config", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-remove")!.handler("nonexistent", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
        "warning",
      );
    });

    it("removes server from config", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      await writeFile(
        join(tmpDir, ".mcp.json"),
        JSON.stringify({
          target: { command: "npx", args: ["-y", "pkg"] },
          keep: { command: "node" },
        }),
      );

      // Load config to set activeConfigPath without spawning real processes
      await loadConfig(tmpDir);

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("mcp-remove")!.handler("target", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Removed MCP server "target"'),
        "info",
      );

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.target).toBeUndefined();
      expect(content.keep).toBeDefined();
    });
  });

  describe("/mcp-test command", () => {
    it("warns on empty args", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext();
      await mock.getCommand("mcp-test")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });

    it("warns when server not connected", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const ctx = createMockContext();
      await mock.getCommand("mcp-test")!.handler("nonexistent", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not connected"),
        "warning",
      );
    });

    it("reports success on ping", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      connections.set("srv", {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport: createMockTransport(),
        tools: [],
        connected: true,
      });

      const ctx = createMockContext();
      await mock.getCommand("mcp-test")!.handler("srv", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("responsive"),
        "info",
      );
    });

    it("reports error on ping failure", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const transport = createMockTransport();
      transport.request = vi.fn(async () => {
        throw new Error("timeout");
      });
      connections.set("srv", {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [],
        connected: true,
      });

      const ctx = createMockContext();
      await mock.getCommand("mcp-test")!.handler("srv", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("test failed"),
        "error",
      );
    });
  });

  // --- Session Lifecycle ---

  describe("session lifecycle", () => {
    it("disconnects all on session_shutdown", async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      const transport = createMockTransport();
      connections.set("srv", {
        name: "srv",
        config: { type: "stdio", command: "node" },
        transport,
        tools: [],
        connected: true,
      });

      await mock.emit("session_shutdown");

      expect(transport.closed).toBe(true);
      expect(connections.size).toBe(0);
    });
  });

  // --- PKCE Utilities ---

  describe("generateCodeVerifier()", () => {
    it("returns a base64url string", () => {
      const verifier = generateCodeVerifier();
      expect(typeof verifier).toBe("string");
      expect(verifier.length).toBeGreaterThan(0);
      // base64url has no +, /, or = characters
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("generates unique values", () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });

    it("has correct length for 32 random bytes", () => {
      const verifier = generateCodeVerifier();
      // 32 bytes → 43 base64url chars (ceil(32*4/3) without padding)
      expect(verifier.length).toBe(43);
    });
  });

  describe("generateCodeChallenge()", () => {
    it("returns a base64url string", () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is deterministic for same verifier", () => {
      const verifier = "test-verifier-12345";
      const a = generateCodeChallenge(verifier);
      const b = generateCodeChallenge(verifier);
      expect(a).toBe(b);
    });

    it("is different for different verifiers", () => {
      const a = generateCodeChallenge("verifier-a");
      const b = generateCodeChallenge("verifier-b");
      expect(a).not.toBe(b);
    });

    it("produces SHA-256 hash length", () => {
      const challenge = generateCodeChallenge("any-verifier");
      // SHA-256 = 32 bytes → 43 base64url chars
      expect(challenge.length).toBe(43);
    });
  });

  describe("generateState()", () => {
    it("returns a hex string", () => {
      const state = generateState();
      expect(state).toMatch(/^[0-9a-f]+$/);
    });

    it("has correct length for 16 random bytes", () => {
      const state = generateState();
      // 16 bytes → 32 hex chars
      expect(state.length).toBe(32);
    });

    it("generates unique values", () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toBe(b);
    });
  });

  // --- OAuthProvider ---

  describe("OAuthProvider", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "oauth-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    describe("discoverMetadata()", () => {
      it("fetches from well-known endpoint", async () => {
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        };
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({
            ok: true,
            json: async () => metadata,
          })),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const result = await provider.discoverMetadata();

        expect(result.authorization_endpoint).toBe(
          "https://auth.example.com/authorize",
        );
        expect(result.token_endpoint).toBe("https://auth.example.com/token");
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
          "https://mcp.example.com/.well-known/oauth-authorization-server",
        );
      });

      it("falls back to derived endpoints on discovery failure", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({ ok: false, status: 404 })),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const result = await provider.discoverMetadata();

        expect(result.authorization_endpoint).toBe(
          "https://mcp.example.com/authorize",
        );
        expect(result.token_endpoint).toBe("https://mcp.example.com/token");
        expect(result.registration_endpoint).toBe(
          "https://mcp.example.com/register",
        );
      });

      it("falls back on network error", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("Network error");
          }),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const result = await provider.discoverMetadata();

        expect(result.authorization_endpoint).toBe(
          "https://mcp.example.com/authorize",
        );
      });

      it("caches metadata after first fetch", async () => {
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        };
        const fetchMock = vi.fn(async () => ({
          ok: true,
          json: async () => metadata,
        }));
        vi.stubGlobal("fetch", fetchMock);

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        await provider.discoverMetadata();
        await provider.discoverMetadata();

        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    describe("registerClient()", () => {
      it("uses config client_id when provided", async () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
          { client_id: "pre-registered" },
        );
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        };

        const result = await provider.registerClient(metadata);
        expect(result.client_id).toBe("pre-registered");
      });

      it("performs dynamic registration", async () => {
        const clientInfo = {
          client_id: "dynamic-123",
          client_secret: "secret-abc",
        };
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({
            ok: true,
            json: async () => clientInfo,
          })),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        };

        const result = await provider.registerClient(metadata);
        expect(result.client_id).toBe("dynamic-123");
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
          "https://auth.example.com/register",
          expect.objectContaining({ method: "POST" }),
        );
      });

      it("throws when no registration endpoint and no client_id", async () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
        };

        await expect(provider.registerClient(metadata)).rejects.toThrow(
          "does not support dynamic registration",
        );
      });

      it("throws with helpful message when registration fails", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => ({
            ok: false,
            status: 400,
            text: async () => "invalid_client",
          })),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const metadata: AuthServerMetadata = {
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        };

        await expect(provider.registerClient(metadata)).rejects.toThrow(
          "Dynamic client registration failed",
        );
      });
    });

    describe("refreshTokens()", () => {
      it("throws when no refresh token", async () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );

        await expect(provider.refreshTokens()).rejects.toThrow(
          "No refresh token available",
        );
      });
    });

    describe("getAccessToken()", () => {
      it("returns null when no tokens", async () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const token = await provider.getAccessToken();
        expect(token).toBeNull();
      });
    });

    describe("hasTokens()", () => {
      it("returns false initially", () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        expect(provider.hasTokens()).toBe(false);
      });
    });

    describe("token persistence", () => {
      it("persists and loads tokens", async () => {
        // Create a provider, manually set state, persist
        const provider1 = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );

        // Simulate having discovered metadata and tokens by loading a store file
        const storeData = {
          "test-server": {
            metadata: {
              authorization_endpoint: "https://auth.example.com/authorize",
              token_endpoint: "https://auth.example.com/token",
            },
            client: { client_id: "test-client" },
            tokens: {
              access_token: "test-access-token",
              token_type: "Bearer",
              refresh_token: "test-refresh-token",
              expires_at: Date.now() + 3600_000,
            },
          },
        };

        await mkdir(join(tmpDir, ".pi"), { recursive: true });
        await writeFile(
          join(tmpDir, ".pi", "mcp-tokens.json"),
          JSON.stringify(storeData),
        );

        const loaded = await provider1.loadPersistedTokens();
        expect(loaded).toBe(true);
        expect(provider1.hasTokens()).toBe(true);

        const token = await provider1.getAccessToken();
        expect(token).toBe("test-access-token");
      });

      it("returns false when no persisted tokens", async () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const loaded = await provider.loadPersistedTokens();
        expect(loaded).toBe(false);
        expect(provider.hasTokens()).toBe(false);
      });

      it("returns false when server not in store", async () => {
        await mkdir(join(tmpDir, ".pi"), { recursive: true });
        await writeFile(
          join(tmpDir, ".pi", "mcp-tokens.json"),
          JSON.stringify({
            "other-server": {
              metadata: {
                authorization_endpoint: "https://x/authorize",
                token_endpoint: "https://x/token",
              },
              client: { client_id: "c" },
              tokens: { access_token: "t", token_type: "Bearer" },
            },
          }),
        );

        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        const loaded = await provider.loadPersistedTokens();
        expect(loaded).toBe(false);
      });

      it("getTokenStorePath returns correct path", () => {
        const provider = new OAuthProvider(
          "test-server",
          "https://mcp.example.com/v1",
          tmpDir,
        );
        expect(provider.getTokenStorePath()).toBe(
          join(tmpDir, ".pi", "mcp-tokens.json"),
        );
      });
    });
  });

  // --- HttpTransport OAuth Integration ---

  describe("HttpTransport OAuth", () => {
    it("injects Bearer token when authProvider has tokens", async () => {
      const mockProvider = {
        getAccessToken: vi.fn(async () => "oauth-token-123"),
        handleUnauthorized: vi.fn(),
        loadPersistedTokens: vi.fn(),
        hasTokens: vi.fn(() => true),
      } as any;

      const initResponses = mcpInitResponses();
      const toolsResponse = createMockResponse({
        body: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      });
      const responses = [...initResponses, toolsResponse];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const transport = new HttpTransport(
        "http://localhost:8080/mcp",
        {},
        mockProvider,
      );
      await transport.initialize();
      await transport.request("tools/list");

      // All 3 calls should have Authorization header
      for (const call of vi.mocked(fetch).mock.calls) {
        expect((call[1] as any).headers.Authorization).toBe(
          "Bearer oauth-token-123",
        );
      }
    });

    it("does not inject token when authProvider returns null", async () => {
      const mockProvider = {
        getAccessToken: vi.fn(async () => null),
        handleUnauthorized: vi.fn(),
        loadPersistedTokens: vi.fn(),
        hasTokens: vi.fn(() => false),
      } as any;

      const responses = mcpInitResponses();
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const transport = new HttpTransport(
        "http://localhost:8080/mcp",
        {},
        mockProvider,
      );
      await transport.initialize();

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBeUndefined();
    });

    it("retries on 401 with new token from handleUnauthorized", async () => {
      const mockProvider = {
        getAccessToken: vi.fn(async () => "expired-token"),
        handleUnauthorized: vi.fn(async () => "new-fresh-token"),
        loadPersistedTokens: vi.fn(),
        hasTokens: vi.fn(() => true),
      } as any;

      // Build responses: init succeeds, then 401, then retry succeeds
      const initResponses2 = mcpInitResponses();
      const unauthorizedResp = createMockResponse({
        status: 401,
        body: "Unauthorized",
      });
      const retrySuccessResp = createMockResponse({
        body: {
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        },
      });

      const responses = [...initResponses2, unauthorizedResp, retrySuccessResp];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const transport = new HttpTransport(
        "http://localhost:8080/mcp",
        {},
        mockProvider,
      );
      await transport.initialize();
      const result = await transport.request("tools/list");

      expect(result.result).toEqual({ tools: [] });
      expect(mockProvider.handleUnauthorized).toHaveBeenCalledTimes(1);

      // The retry call should have the new token
      const retryCall = vi.mocked(fetch).mock.calls[3]; // 4th call (init=2, 401=1, retry=1)
      expect((retryCall[1] as any).headers.Authorization).toBe(
        "Bearer new-fresh-token",
      );
    });

    it("throws on 401 when no authProvider", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          createMockResponse({ status: 401, body: "Unauthorized" }),
        ),
      );

      const transport = new HttpTransport("http://localhost:8080/mcp");
      await expect(transport.initialize()).rejects.toThrow("HTTP 401");
    });

    it("throws when retry after 401 also fails", async () => {
      const mockProvider = {
        getAccessToken: vi.fn(async () => "expired-token"),
        handleUnauthorized: vi.fn(async () => "still-bad-token"),
        loadPersistedTokens: vi.fn(),
        hasTokens: vi.fn(() => true),
      } as any;

      const unauthorizedResp = createMockResponse({
        status: 401,
        body: "Unauthorized",
      });
      const retryFailResp = createMockResponse({
        status: 403,
        body: "Forbidden",
      });

      const responses = [unauthorizedResp, retryFailResp];
      let callIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responses[callIndex++]),
      );

      const transport = new HttpTransport(
        "http://localhost:8080/mcp",
        {},
        mockProvider,
      );
      await expect(transport.initialize()).rejects.toThrow("HTTP 403");
    });
  });

  // --- Config with OAuth ---

  describe("normalizeConfig() with oauth", () => {
    it("passes through oauth: true", () => {
      const result = normalizeConfig({
        myserver: {
          type: "http",
          url: "https://mcp.example.com",
          oauth: true,
        },
      });
      expect(result.mcpServers.myserver.oauth).toBe(true);
    });

    it("passes through oauth object", () => {
      const result = normalizeConfig({
        myserver: {
          type: "http",
          url: "https://mcp.example.com",
          oauth: { scope: "read write", client_id: "my-app" },
        },
      });
      const oauth = result.mcpServers.myserver.oauth as {
        scope: string;
        client_id: string;
      };
      expect(oauth.scope).toBe("read write");
      expect(oauth.client_id).toBe("my-app");
    });

    it("omits oauth when not present", () => {
      const result = normalizeConfig({
        myserver: { type: "http", url: "https://mcp.example.com" },
      });
      expect(result.mcpServers.myserver.oauth).toBeUndefined();
    });

    it("handles Pi format with oauth", () => {
      const result = normalizeConfig({
        mcpServers: {
          myserver: {
            type: "http",
            url: "https://mcp.example.com",
            oauth: true,
          },
        },
      });
      expect(result.mcpServers.myserver.oauth).toBe(true);
    });
  });

  describe("saveConfig() with oauth", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "mcp-oauth-save-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it("saves oauth: true in Claude flat format", async () => {
      await writeFile(join(tmpDir, ".mcp.json"), "{}");
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          api: {
            type: "http",
            url: "https://mcp.example.com",
            oauth: true,
          },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.api.oauth).toBe(true);
      expect(content.api.type).toBe("http");
      expect(content.api.url).toBe("https://mcp.example.com");
    });

    it("saves oauth object in Claude flat format", async () => {
      await writeFile(join(tmpDir, ".mcp.json"), "{}");
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          api: {
            type: "http",
            url: "https://mcp.example.com",
            oauth: { scope: "read", client_id: "my-id" },
          },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.api.oauth).toEqual({ scope: "read", client_id: "my-id" });
    });

    it("does not save oauth for stdio servers", async () => {
      await writeFile(join(tmpDir, ".mcp.json"), "{}");
      await loadConfig(tmpDir);

      await saveConfig(tmpDir, {
        mcpServers: {
          local: { type: "stdio", command: "node" },
        },
      });

      const content = JSON.parse(
        await readFile(join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.local.oauth).toBeUndefined();
    });
  });

  // --- createTransport with OAuth ---

  describe("createTransport() with oauth", () => {
    it("creates HttpTransport with OAuthProvider when oauth: true", () => {
      const transport = createTransport(
        {
          type: "http",
          url: "https://mcp.example.com",
          oauth: true,
        },
        "test-server",
      );
      expect(transport).toBeInstanceOf(HttpTransport);
      expect((transport as HttpTransport).authProvider).toBeInstanceOf(
        OAuthProvider,
      );
    });

    it("creates HttpTransport with OAuthProvider when oauth has options", () => {
      const transport = createTransport(
        {
          type: "http",
          url: "https://mcp.example.com",
          oauth: { scope: "read", client_id: "my-app" },
        },
        "test-server",
      );
      expect(transport).toBeInstanceOf(HttpTransport);
      expect((transport as HttpTransport).authProvider).toBeInstanceOf(
        OAuthProvider,
      );
    });

    it("creates HttpTransport without OAuthProvider when no oauth", () => {
      const transport = createTransport(
        {
          type: "http",
          url: "https://mcp.example.com",
        },
        "test-server",
      );
      expect(transport).toBeInstanceOf(HttpTransport);
      expect((transport as HttpTransport).authProvider).toBeNull();
    });

    it("does not create OAuthProvider without server name", () => {
      const transport = createTransport({
        type: "http",
        url: "https://mcp.example.com",
        oauth: true,
      });
      expect(transport).toBeInstanceOf(HttpTransport);
      expect((transport as HttpTransport).authProvider).toBeNull();
    });
  });
});
