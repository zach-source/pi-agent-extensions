/**
 * MCP Server Extension for Pi
 *
 * General-purpose MCP client that connects to any MCP server (stdio or HTTP),
 * discovers tools, and dynamically registers them as Pi tools.
 *
 * Config (checked in order, first found wins):
 *   1. .mcp.json       — Claude Code format (flat: { "name": { command, args } })
 *   2. .pi/mcp.json    — Pi format (wrapped: { mcpServers: { "name": { type, ... } } })
 *
 * Tools:
 *   mcp_manage           - List/connect/disconnect/reconnect/test servers
 *   mcp_{server}_{tool}  - Dynamically registered per discovered MCP tool
 *
 * Commands:
 *   /mcp        - Status dashboard
 *   /mcp-list   - All tools from all servers
 *   /mcp-add    - Add a server to config
 *   /mcp-remove - Remove a server from config
 *   /mcp-test   - Test connectivity to a server
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { spawn, type ChildProcess, exec } from "child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";

// Local StringEnum helper (avoids runtime dependency on @mariozechner/pi-ai)
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: Record<string, unknown>,
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// --- Types & Interfaces ---

interface OAuthConfig {
  scope?: string;
  client_id?: string;
}

interface McpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: boolean | OAuthConfig;
}

interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  expires_at?: number;
  refresh_token?: string;
  scope?: string;
}

interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  registration_access_token?: string;
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface OAuthTokenStore {
  metadata: AuthServerMetadata;
  client: OAuthClientInfo;
  tokens: OAuthTokens;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpTransport {
  initialize(): Promise<JsonRpcResponse>;
  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

interface McpConnection {
  name: string;
  config: McpServerConfig;
  transport: McpTransport;
  tools: McpToolInfo[];
  connected: boolean;
  error?: string;
}

// --- JSON-RPC Helpers ---

const PROTOCOL_VERSION = "2025-03-26";
let requestIdCounter = 0;

function jsonrpc(
  method: string,
  params?: Record<string, unknown>,
  reqId?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: reqId ?? ++requestIdCounter,
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

// --- PKCE Utilities ---

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// --- Browser Opener ---

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}

// --- OAuthProvider ---

type NotifyFn = (message: string, level?: string) => void;

class OAuthProvider {
  private serverUrl: string;
  private scope?: string;
  private configClientId?: string;
  private metadata: AuthServerMetadata | null = null;
  private client: OAuthClientInfo | null = null;
  private tokens: OAuthTokens | null = null;
  private tokenStorePath: string;
  private serverName: string;
  private authInProgress: Promise<OAuthTokens> | null = null;
  private notify: NotifyFn;

  constructor(
    serverName: string,
    serverUrl: string,
    cwd: string,
    opts?: { scope?: string; client_id?: string },
    notify?: NotifyFn,
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.scope = opts?.scope;
    this.configClientId = opts?.client_id;
    this.tokenStorePath = join(cwd, ".pi", "mcp-tokens.json");
    this.notify = notify ?? (() => {});
  }

  async discoverMetadata(): Promise<AuthServerMetadata> {
    if (this.metadata) return this.metadata;

    const origin = new URL(this.serverUrl).origin;
    try {
      const resp = await fetch(
        `${origin}/.well-known/oauth-authorization-server`,
      );
      if (resp.ok) {
        this.metadata = (await resp.json()) as AuthServerMetadata;
        return this.metadata;
      }
    } catch {
      // Discovery failed, use fallback
    }

    // Fallback: derive endpoints from origin
    this.metadata = {
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
    };
    return this.metadata;
  }

  async registerClient(metadata: AuthServerMetadata): Promise<OAuthClientInfo> {
    if (this.configClientId) {
      this.client = { client_id: this.configClientId };
      return this.client;
    }

    if (this.client) return this.client;

    if (!metadata.registration_endpoint) {
      throw new Error(
        "OAuth server does not support dynamic registration. " +
          'Provide a client_id in your config: oauth: { client_id: "..." }',
      );
    }

    const resp = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `pi-mcp-ext (${this.serverName})`,
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Dynamic client registration failed (${resp.status}): ${text}. ` +
          'Provide a client_id in your config: oauth: { client_id: "..." }',
      );
    }

    this.client = (await resp.json()) as OAuthClientInfo;
    return this.client;
  }

  private startCallbackServer(): Promise<{
    port: number;
    waitForCode: Promise<string>;
    server: HttpServer;
  }> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      let codeResolve: (code: string) => void;
      let codeReject: (err: Error) => void;
      const waitForCode = new Promise<string>((res, rej) => {
        codeResolve = res;
        codeReject = rej;
      });

      const timeout = setTimeout(() => {
        server.close();
        codeReject(new Error("OAuth callback timed out after 120 seconds"));
      }, 120_000);

      server.on("request", (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");

        res.writeHead(200, { "Content-Type": "text/html" });
        if (code) {
          res.end(
            "<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>",
          );
          clearTimeout(timeout);
          server.close();
          codeResolve(JSON.stringify({ code, state: returnedState }));
        } else {
          res.end(
            `<html><body><h1>Authorization failed</h1><p>${error || "Unknown error"}</p></body></html>`,
          );
          clearTimeout(timeout);
          server.close();
          codeReject(
            new Error(`OAuth authorization failed: ${error || "unknown"}`),
          );
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to start callback server"));
          return;
        }
        resolve({ port: addr.port, waitForCode, server });
      });

      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async exchangeCode(
    metadata: AuthServerMetadata,
    client: OAuthClientInfo,
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: codeVerifier,
    });
    if (client.client_secret) {
      body.set("client_secret", client.client_secret);
    }

    const resp = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const tokens = (await resp.json()) as OAuthTokens;
    if (tokens.expires_in) {
      tokens.expires_at = Date.now() + tokens.expires_in * 1000;
    }
    return tokens;
  }

  async authorize(): Promise<OAuthTokens> {
    // Deduplicate concurrent auth attempts
    if (this.authInProgress) return this.authInProgress;

    this.authInProgress = this._doAuthorize().finally(() => {
      this.authInProgress = null;
    });
    return this.authInProgress;
  }

  private async _doAuthorize(): Promise<OAuthTokens> {
    const metadata = await this.discoverMetadata();
    const client = await this.registerClient(metadata);

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    const { port, waitForCode } = await this.startCallbackServer();
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    if (this.scope) params.set("scope", this.scope);

    const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`;

    this.notify(
      `Opening browser for OAuth authorization to ${this.serverName}...`,
    );
    openBrowser(authUrl);

    const rawResult = await waitForCode;
    const { code, state: returnedState } = JSON.parse(rawResult) as {
      code: string;
      state: string;
    };

    if (returnedState !== state) {
      throw new Error(
        "OAuth state mismatch — possible CSRF attack. Authorization rejected.",
      );
    }

    this.tokens = await this.exchangeCode(
      metadata,
      client,
      code,
      codeVerifier,
      redirectUri,
    );
    await this.persistTokens();
    return this.tokens;
  }

  async refreshTokens(): Promise<OAuthTokens> {
    if (!this.tokens?.refresh_token) {
      throw new Error("No refresh token available");
    }

    const metadata = await this.discoverMetadata();
    if (!this.client) throw new Error("No client info for refresh");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refresh_token,
      client_id: this.client.client_id,
    });
    if (this.client.client_secret) {
      body.set("client_secret", this.client.client_secret);
    }

    const resp = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      // Clear tokens so next call triggers full re-auth
      this.tokens = null;
      throw new Error(`Token refresh failed (${resp.status})`);
    }

    const newTokens = (await resp.json()) as OAuthTokens;
    if (newTokens.expires_in) {
      newTokens.expires_at = Date.now() + newTokens.expires_in * 1000;
    }
    // Preserve refresh_token if not rotated
    if (!newTokens.refresh_token && this.tokens?.refresh_token) {
      newTokens.refresh_token = this.tokens.refresh_token;
    }
    this.tokens = newTokens;
    await this.persistTokens();
    return this.tokens;
  }

  async getAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;

    // Proactive refresh: if token expires within 60 seconds
    if (
      this.tokens.expires_at &&
      Date.now() > this.tokens.expires_at - 60_000
    ) {
      try {
        await this.refreshTokens();
      } catch {
        // Refresh failed; return current token and let 401 trigger re-auth
      }
    }

    return this.tokens.access_token;
  }

  async handleUnauthorized(): Promise<string> {
    // Try refresh first
    if (this.tokens?.refresh_token) {
      try {
        const refreshed = await this.refreshTokens();
        return refreshed.access_token;
      } catch {
        // Refresh failed, fall through to full re-auth
      }
    }

    // Full re-authorization
    const tokens = await this.authorize();
    return tokens.access_token;
  }

  async persistTokens(): Promise<void> {
    if (!this.tokens || !this.metadata || !this.client) return;
    try {
      let store: Record<string, OAuthTokenStore> = {};
      try {
        const existing = await readFile(this.tokenStorePath, "utf-8");
        store = JSON.parse(existing) as Record<string, OAuthTokenStore>;
      } catch {
        // File doesn't exist yet
      }
      store[this.serverName] = {
        metadata: this.metadata,
        client: this.client,
        tokens: this.tokens,
      };
      await mkdir(dirname(this.tokenStorePath), { recursive: true });
      await writeFile(this.tokenStorePath, JSON.stringify(store, null, 2));
    } catch {
      // Non-fatal: tokens just won't persist
    }
  }

  async loadPersistedTokens(): Promise<boolean> {
    try {
      const content = await readFile(this.tokenStorePath, "utf-8");
      const store = JSON.parse(content) as Record<string, OAuthTokenStore>;
      const entry = store[this.serverName];
      if (entry) {
        this.metadata = entry.metadata;
        this.client = entry.client;
        this.tokens = entry.tokens;
        return true;
      }
    } catch {
      // No persisted tokens
    }
    return false;
  }

  hasTokens(): boolean {
    return this.tokens !== null;
  }

  getTokenStorePath(): string {
    return this.tokenStorePath;
  }
}

// --- HttpTransport ---

class HttpTransport implements McpTransport {
  private sessionId: string | null = null;
  private url: string;
  private baseHeaders: Record<string, string>;
  authProvider: OAuthProvider | null;

  constructor(
    url: string,
    headers?: Record<string, string>,
    authProvider?: OAuthProvider,
  ) {
    this.url = url;
    this.baseHeaders = headers ?? {};
    this.authProvider = authProvider ?? null;
  }

  private parseResponse(
    resp: { headers: { get(name: string): string | null } },
    text: string,
    payloadId: unknown,
  ): JsonRpcResponse {
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      return parseSSE(text);
    }
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: typeof payloadId === "number" ? (payloadId as number) : 0,
        result: {},
      };
    }
    return JSON.parse(text) as JsonRpcResponse;
  }

  private async post(
    payload: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.baseHeaders,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    // Inject OAuth Bearer token if available
    if (this.authProvider) {
      const token = await this.authProvider.getAccessToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    const resp = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // Handle 401 with OAuth retry
    if (resp.status === 401 && this.authProvider) {
      const newToken = await this.authProvider.handleUnauthorized();
      const retryHeaders = { ...headers, Authorization: `Bearer ${newToken}` };
      const retryResp = await fetch(this.url, {
        method: "POST",
        headers: retryHeaders,
        body: JSON.stringify(payload),
      });

      const retrySid = retryResp.headers.get("mcp-session-id");
      if (retrySid) this.sessionId = retrySid;

      if (!retryResp.ok) {
        throw new Error(`HTTP ${retryResp.status}: ${await retryResp.text()}`);
      }

      const retryText = await retryResp.text();
      return this.parseResponse(retryResp, retryText, payload.id);
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const text = await resp.text();
    return this.parseResponse(resp, text, payload.id);
  }

  async initialize(): Promise<JsonRpcResponse> {
    this.sessionId = null;

    const initResp = await this.post(
      jsonrpc(
        "initialize",
        {
          clientInfo: { name: "pi-mcp-ext", version: "1.0" },
          capabilities: {},
          protocolVersion: PROTOCOL_VERSION,
        },
        0,
      ),
    );

    if (initResp.error) return initResp;

    await this.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    return initResp;
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    return this.post(jsonrpc(method, params));
  }

  async close(): Promise<void> {
    this.sessionId = null;
  }
}

// --- StdioTransport ---

class StdioTransport implements McpTransport {
  private process: ChildProcess | null = null;
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private pending = new Map<
    number,
    {
      resolve: (resp: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  >();
  private buffer = "";

  constructor(command: string, args?: string[], env?: Record<string, string>) {
    this.command = command;
    this.args = args ?? [];
    this.env = env ?? {};
  }

  private spawn(): void {
    this.process = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      // stderr is for logging; ignore in normal flow
      const msg = chunk.toString().trim();
      if (msg) {
        // Could log to debug, but keep quiet for now
      }
    });

    this.process.on("error", (err) => {
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.process.on("close", () => {
      for (const [, p] of this.pending) {
        p.reject(new Error("Process exited"));
      }
      this.pending.clear();
      this.process = null;
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        // Only resolve messages with an id (responses, not notifications)
        if (msg.id !== undefined && msg.id !== null) {
          const pending = this.pending.get(msg.id as number);
          if (pending) {
            this.pending.delete(msg.id as number);
            pending.resolve(msg);
          }
        }
      } catch {
        // Non-JSON line, ignore
      }
    }
  }

  private send(payload: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error("Process not running"));
    }

    const id = payload.id as number;

    // Notifications (no id) don't expect a response
    if (id === undefined || id === null) {
      this.process.stdin.write(JSON.stringify(payload) + "\n");
      return Promise.resolve({
        jsonrpc: "2.0",
        id: 0,
        result: {},
      });
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.process!.stdin!.write(JSON.stringify(payload) + "\n");
    });
  }

  async initialize(): Promise<JsonRpcResponse> {
    this.spawn();

    const initResp = await this.send(
      jsonrpc(
        "initialize",
        {
          clientInfo: { name: "pi-mcp-ext", version: "1.0" },
          capabilities: {},
          protocolVersion: PROTOCOL_VERSION,
        },
        0,
      ),
    );

    if (initResp.error) return initResp;

    // Send notifications/initialized (no id, no response expected)
    await this.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    return initResp;
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    return this.send(jsonrpc(method, params));
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error("Transport closed"));
    }
    this.pending.clear();
    this.buffer = "";
  }
}

// --- Config Management ---

const CONFIG_PATHS = [".mcp.json", ".pi/mcp.json"];

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? "";
  });
}

function expandHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    expanded[key] = expandEnvVars(value);
  }
  return expanded;
}

/**
 * Infer the transport type from a raw server entry.
 * Claude format: no `type` field; stdio has `command`, http has `url`.
 * Pi format: explicit `type` field.
 */
function inferType(entry: Record<string, unknown>): "stdio" | "http" {
  if (entry.type === "http") return "http";
  if (entry.type === "stdio") return "stdio";
  if (typeof entry.url === "string") return "http";
  return "stdio"; // default: presence of command (or anything else) → stdio
}

/**
 * Normalize a raw JSON object into McpConfigFile.
 * Supports two formats:
 *   Claude: { "name": { command, args, env, url, headers } }
 *   Pi:     { mcpServers: { "name": { type, command, args, ... } } }
 */
function normalizeConfig(raw: Record<string, unknown>): McpConfigFile {
  // Pi format: has mcpServers key
  if (raw.mcpServers && typeof raw.mcpServers === "object") {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(
      raw.mcpServers as Record<string, Record<string, unknown>>,
    )) {
      if (!entry || typeof entry !== "object") continue;
      servers[name] = {
        type: inferType(entry),
        command: entry.command as string | undefined,
        args: entry.args as string[] | undefined,
        env: entry.env as Record<string, string> | undefined,
        url: entry.url as string | undefined,
        headers: entry.headers as Record<string, string> | undefined,
        oauth: entry.oauth as boolean | OAuthConfig | undefined,
      };
    }
    return { mcpServers: servers };
  }

  // Claude flat format: each top-level key is a server name
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    servers[name] = {
      type: inferType(e),
      command: e.command as string | undefined,
      args: e.args as string[] | undefined,
      env: e.env as Record<string, string> | undefined,
      url: e.url as string | undefined,
      headers: e.headers as Record<string, string> | undefined,
      oauth: e.oauth as boolean | OAuthConfig | undefined,
    };
  }
  return { mcpServers: servers };
}

let activeConfigPath: string | null = null;

async function loadConfig(cwd: string): Promise<McpConfigFile> {
  for (const configPath of CONFIG_PATHS) {
    try {
      const content = await readFile(join(cwd, configPath), "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      activeConfigPath = configPath;
      return normalizeConfig(parsed);
    } catch {
      // File doesn't exist or invalid JSON, try next
    }
  }
  activeConfigPath = null;
  return { mcpServers: {} };
}

async function saveConfig(cwd: string, config: McpConfigFile): Promise<void> {
  // Save to whichever config file was loaded, defaulting to .mcp.json (Claude format)
  const configPath = activeConfigPath ?? ".mcp.json";
  const filePath = join(cwd, configPath);
  await mkdir(dirname(filePath), { recursive: true });

  // If saving to .mcp.json, use Claude's flat format
  if (configPath === ".mcp.json") {
    const flat: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(config.mcpServers)) {
      const entry: Record<string, unknown> = {};
      if (server.type === "http") {
        entry.type = "http";
        if (server.url) entry.url = server.url;
        if (server.headers) entry.headers = server.headers;
        if (server.oauth !== undefined) entry.oauth = server.oauth;
      } else {
        if (server.command) entry.command = server.command;
        if (server.args?.length) entry.args = server.args;
        if (server.env && Object.keys(server.env).length > 0)
          entry.env = server.env;
      }
      flat[name] = entry;
    }
    await writeFile(filePath, JSON.stringify(flat, null, 2) + "\n");
  } else {
    await writeFile(filePath, JSON.stringify(config, null, 2) + "\n");
  }
}

// --- Connection Manager ---

const connections = new Map<string, McpConnection>();

let oauthNotify: NotifyFn = () => {};
let oauthCwd = "";

function createTransport(
  config: McpServerConfig,
  serverName?: string,
): McpTransport {
  if (config.type === "http") {
    if (!config.url) throw new Error("HTTP transport requires url");
    let authProvider: OAuthProvider | undefined;
    if (config.oauth && serverName) {
      const oauthOpts =
        typeof config.oauth === "object" ? config.oauth : undefined;
      authProvider = new OAuthProvider(
        serverName,
        config.url,
        oauthCwd,
        oauthOpts,
        oauthNotify,
      );
    }
    return new HttpTransport(
      config.url,
      expandHeaders(config.headers),
      authProvider,
    );
  }
  if (config.type === "stdio") {
    if (!config.command) throw new Error("Stdio transport requires command");
    return new StdioTransport(config.command, config.args, config.env);
  }
  throw new Error(`Unknown transport type: ${config.type}`);
}

async function connectServer(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const transport = createTransport(config, name);

  const conn: McpConnection = {
    name,
    config,
    transport,
    tools: [],
    connected: false,
  };

  // Load persisted OAuth tokens before initialize
  if (transport instanceof HttpTransport && transport.authProvider) {
    await transport.authProvider.loadPersistedTokens();
  }

  try {
    const initResp = await transport.initialize();
    if (initResp.error) {
      conn.error = `Init failed: ${initResp.error.message}`;
      connections.set(name, conn);
      return conn;
    }

    // Discover tools
    const toolsResp = await transport.request("tools/list");
    if (toolsResp.result?.tools) {
      conn.tools = toolsResp.result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      }));
    }

    conn.connected = true;
  } catch (e) {
    conn.error = e instanceof Error ? e.message : String(e);
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }

  connections.set(name, conn);
  return conn;
}

async function connectAll(
  mcpServers: Record<string, McpServerConfig>,
): Promise<McpConnection[]> {
  const entries = Object.entries(mcpServers);
  if (entries.length === 0) return [];

  const results = await Promise.allSettled(
    entries.map(([name, config]) => connectServer(name, config)),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<McpConnection> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);
}

async function disconnectAll(): Promise<void> {
  const closePromises = Array.from(connections.values()).map(async (conn) => {
    try {
      await conn.transport.close();
    } catch {
      /* ignore */
    }
  });
  await Promise.allSettled(closePromises);
  connections.clear();
}

async function disconnectServer(name: string): Promise<boolean> {
  const conn = connections.get(name);
  if (!conn) return false;
  try {
    await conn.transport.close();
  } catch {
    /* ignore */
  }
  connections.delete(name);
  return true;
}

// --- Tool Bridge ---

function toolName(serverName: string, mcpToolName: string): string {
  // Strip redundant prefix: if tool name already starts with server name
  const prefix = `${serverName}_`;
  const suffix = mcpToolName.startsWith(prefix)
    ? mcpToolName.slice(prefix.length)
    : mcpToolName;
  return `mcp_${serverName}_${suffix}`;
}

function registerMcpTools(pi: ExtensionAPI, conn: McpConnection): void {
  for (const tool of conn.tools) {
    const name = toolName(conn.name, tool.name);

    pi.registerTool({
      name,
      label: `${conn.name}: ${tool.name}`,
      description: `[MCP: ${conn.name}] ${tool.description || tool.name}`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),

      async execute(_toolCallId: string, params: Record<string, unknown>) {
        if (!conn.connected) {
          return {
            content: [
              {
                type: "text",
                text: `Server "${conn.name}" is not connected. Use /mcp to check status.`,
              },
            ],
            details: {},
          };
        }

        try {
          const resp = await conn.transport.request("tools/call", {
            name: tool.name,
            arguments: params,
          });

          if (resp.error) {
            return {
              content: [
                { type: "text", text: `RPC error: ${resp.error.message}` },
              ],
              details: {},
            };
          }

          const result = resp.result || {};
          const texts = (result.content || [])
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!);

          return {
            content: [
              {
                type: "text",
                text: texts.join("\n") || JSON.stringify(result, null, 2),
              },
            ],
            details: { isError: !!result.isError },
          };
        } catch (e) {
          conn.connected = false;
          conn.error = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error: ${conn.error}` }],
            details: {},
          };
        }
      },
    });
  }
}

// --- Status Formatting ---

function formatStatus(): string {
  if (connections.size === 0) {
    return "No MCP servers configured. Use `/mcp-add` to add one.";
  }

  const lines: string[] = ["## MCP Servers\n"];
  let totalTools = 0;

  for (const [name, conn] of connections) {
    const status = conn.connected ? "connected" : "disconnected";
    const icon = conn.connected ? "+" : "-";
    lines.push(`${icon} **${name}** (${conn.config.type}) — ${status}`);
    if (conn.error) lines.push(`  Error: ${conn.error}`);
    if (conn.tools.length > 0) {
      lines.push(`  Tools: ${conn.tools.map((t) => t.name).join(", ")}`);
      totalTools += conn.tools.length;
    }
  }

  lines.push(`\n${connections.size} server(s), ${totalTools} tool(s)`);
  return lines.join("\n");
}

function formatToolList(): string {
  if (connections.size === 0) {
    return "No MCP servers connected.";
  }

  const lines: string[] = ["## MCP Tools\n"];

  for (const [name, conn] of connections) {
    if (!conn.connected || conn.tools.length === 0) continue;
    lines.push(`### ${name}\n`);
    for (const tool of conn.tools) {
      const piName = toolName(name, tool.name);
      lines.push(`- **${piName}** — ${tool.description || tool.name}`);
    }
    lines.push("");
  }

  if (lines.length === 1) {
    return "No tools available (no connected servers with tools).";
  }

  return lines.join("\n");
}

// --- Extension Entry Point ---

export default function (pi: ExtensionAPI) {
  let currentCwd = "";

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;
    oauthCwd = ctx.cwd;
    oauthNotify = (msg: string, level?: string) =>
      ctx.ui.notify(msg, (level as "info" | "warning" | "error") ?? "info");
    requestIdCounter = 0;
    await disconnectAll();

    const config = await loadConfig(ctx.cwd);
    const serverEntries = Object.keys(config.mcpServers);
    if (serverEntries.length === 0) return;

    const results = await connectAll(config.mcpServers);

    let toolCount = 0;
    for (const conn of results) {
      if (conn.connected) {
        registerMcpTools(pi, conn);
        toolCount += conn.tools.length;
      }
    }

    if (toolCount > 0) {
      ctx.ui.setStatus("mcp", `mcp: ${toolCount} tools`);
    }

    const failed = results.filter((c) => !c.connected);
    if (failed.length > 0) {
      const names = failed.map((c) => c.name).join(", ");
      ctx.ui.notify(
        `MCP: failed to connect to ${failed.length} server(s): ${names}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await disconnectAll();
  });

  // --- mcp_manage tool ---

  pi.registerTool({
    name: "mcp_manage",
    label: "MCP Manage",
    description:
      "Manage MCP server connections. " +
      "Actions: 'list' (show servers and status), " +
      "'connect' (connect to a server by name), " +
      "'disconnect' (disconnect a server), " +
      "'reconnect' (disconnect then reconnect a server), " +
      "'test' (test connectivity to a server).",
    parameters: Type.Object({
      action: StringEnum(
        ["list", "connect", "disconnect", "reconnect", "test"] as const,
        { description: "Action to perform" },
      ),
      server_name: Type.Optional(
        Type.String({
          description:
            "Server name (required for connect/disconnect/reconnect/test)",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { action, server_name } = params as {
        action: string;
        server_name?: string;
      };

      switch (action) {
        case "list":
          return {
            content: [{ type: "text", text: formatStatus() }],
            details: {
              servers: Array.from(connections.entries()).map(([name, c]) => ({
                name,
                type: c.config.type,
                connected: c.connected,
                tools: c.tools.length,
                error: c.error,
              })),
            },
          };

        case "connect": {
          if (!server_name) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: server_name required for connect.",
                },
              ],
              details: {},
            };
          }
          const config = await loadConfig(currentCwd);
          const serverConfig = config.mcpServers[server_name];
          if (!serverConfig) {
            return {
              content: [
                {
                  type: "text",
                  text: `Server "${server_name}" not found in config.`,
                },
              ],
              details: {},
            };
          }
          const conn = await connectServer(server_name, serverConfig);
          if (conn.connected) {
            registerMcpTools(pi, conn);
            return {
              content: [
                {
                  type: "text",
                  text: `Connected to "${server_name}" with ${conn.tools.length} tool(s).`,
                },
              ],
              details: { tools: conn.tools.map((t) => t.name) },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Failed to connect to "${server_name}": ${conn.error}`,
              },
            ],
            details: {},
          };
        }

        case "disconnect": {
          if (!server_name) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: server_name required for disconnect.",
                },
              ],
              details: {},
            };
          }
          const removed = await disconnectServer(server_name);
          return {
            content: [
              {
                type: "text",
                text: removed
                  ? `Disconnected "${server_name}".`
                  : `Server "${server_name}" not found.`,
              },
            ],
            details: {},
          };
        }

        case "reconnect": {
          if (!server_name) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: server_name required for reconnect.",
                },
              ],
              details: {},
            };
          }
          await disconnectServer(server_name);
          const config2 = await loadConfig(currentCwd);
          const sc = config2.mcpServers[server_name];
          if (!sc) {
            return {
              content: [
                {
                  type: "text",
                  text: `Server "${server_name}" not found in config.`,
                },
              ],
              details: {},
            };
          }
          const conn2 = await connectServer(server_name, sc);
          if (conn2.connected) {
            registerMcpTools(pi, conn2);
            return {
              content: [
                {
                  type: "text",
                  text: `Reconnected to "${server_name}" with ${conn2.tools.length} tool(s).`,
                },
              ],
              details: { tools: conn2.tools.map((t) => t.name) },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Failed to reconnect to "${server_name}": ${conn2.error}`,
              },
            ],
            details: {},
          };
        }

        case "test": {
          if (!server_name) {
            return {
              content: [
                { type: "text", text: "Error: server_name required for test." },
              ],
              details: {},
            };
          }
          const conn = connections.get(server_name);
          if (!conn) {
            return {
              content: [
                {
                  type: "text",
                  text: `Server "${server_name}" not connected.`,
                },
              ],
              details: {},
            };
          }
          try {
            const resp = await conn.transport.request("ping");
            const ok = !resp.error;
            return {
              content: [
                {
                  type: "text",
                  text: ok
                    ? `"${server_name}" is responsive.`
                    : `"${server_name}" error: ${resp.error!.message}`,
                },
              ],
              details: { ok },
            };
          } catch (e) {
            return {
              content: [
                {
                  type: "text",
                  text: `"${server_name}" test failed: ${e instanceof Error ? e.message : String(e)}`,
                },
              ],
              details: { ok: false },
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${action}` }],
            details: {},
          };
      }
    },
  });

  // --- /mcp command ---

  pi.registerCommand("mcp", {
    description: "Show MCP server status dashboard",
    handler: async (_args, _ctx) => {
      pi.sendMessage(
        {
          customType: "mcp-status",
          content: formatStatus(),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /mcp-list command ---

  pi.registerCommand("mcp-list", {
    description: "List all MCP tools from all servers",
    handler: async (_args, _ctx) => {
      pi.sendMessage(
        {
          customType: "mcp-tools",
          content: formatToolList(),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /mcp-add command ---

  pi.registerCommand("mcp-add", {
    description:
      "Add an MCP server: /mcp-add <name> stdio <command> [args...] OR /mcp-add <name> http <url>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /mcp-add <name> stdio <command> [args...] OR /mcp-add <name> http <url>",
          "warning",
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      if (parts.length < 3) {
        ctx.ui.notify(
          "Usage: /mcp-add <name> stdio <command> [args...] OR /mcp-add <name> http <url>",
          "warning",
        );
        return;
      }

      const [name, type, ...rest] = parts;

      if (type !== "stdio" && type !== "http") {
        ctx.ui.notify(
          `Invalid type "${type}". Use "stdio" or "http".`,
          "error",
        );
        return;
      }

      const config = await loadConfig(ctx.cwd);

      if (type === "stdio") {
        config.mcpServers[name] = {
          type: "stdio",
          command: rest[0],
          args: rest.slice(1),
        };
      } else {
        config.mcpServers[name] = {
          type: "http",
          url: rest[0],
        };
      }

      await saveConfig(ctx.cwd, config);
      ctx.ui.notify(
        `Added MCP server "${name}" (${type}). Use /mcp to connect.`,
        "info",
      );
    },
  });

  // --- /mcp-remove command ---

  pi.registerCommand("mcp-remove", {
    description: "Remove an MCP server: /mcp-remove <name>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /mcp-remove <name>", "warning");
        return;
      }

      const name = args.trim();
      const config = await loadConfig(ctx.cwd);

      if (!config.mcpServers[name]) {
        ctx.ui.notify(`Server "${name}" not found in config.`, "warning");
        return;
      }

      // Disconnect if connected
      await disconnectServer(name);

      delete config.mcpServers[name];
      await saveConfig(ctx.cwd, config);
      ctx.ui.notify(`Removed MCP server "${name}".`, "info");
    },
  });

  // --- /mcp-test command ---

  pi.registerCommand("mcp-test", {
    description: "Test connectivity to an MCP server: /mcp-test <name>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /mcp-test <name>", "warning");
        return;
      }

      const name = args.trim();
      const conn = connections.get(name);

      if (!conn) {
        ctx.ui.notify(`Server "${name}" is not connected.`, "warning");
        return;
      }

      try {
        const resp = await conn.transport.request("ping");
        if (resp.error) {
          ctx.ui.notify(`"${name}" error: ${resp.error.message}`, "error");
        } else {
          ctx.ui.notify(`"${name}" is responsive.`, "info");
        }
      } catch (e) {
        ctx.ui.notify(
          `"${name}" test failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });
}

// --- Exports for testing ---

export {
  HttpTransport,
  StdioTransport,
  OAuthProvider,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  openBrowser,
  jsonrpc,
  parseSSE,
  expandEnvVars,
  inferType,
  normalizeConfig,
  toolName,
  formatStatus,
  formatToolList,
  loadConfig,
  saveConfig,
  connections,
  connectServer,
  connectAll,
  disconnectAll,
  disconnectServer,
  registerMcpTools,
  createTransport,
  requestIdCounter,
  CONFIG_PATHS,
  oauthCwd,
  oauthNotify,
};

export type {
  McpServerConfig,
  McpConfigFile,
  JsonRpcResponse,
  McpToolInfo,
  McpTransport,
  McpConnection,
  OAuthConfig,
  OAuthTokens,
  OAuthClientInfo,
  AuthServerMetadata,
  OAuthTokenStore,
};
