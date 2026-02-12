import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import initExtension from "./tools-manager.js";

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
    exec: vi.fn(),
  };

  return {
    api,
    async emit(event: string, eventData: any, ctx: any) {
      const fns = handlers.get(event) ?? [];
      let result: any;
      for (const fn of fns) {
        result = await fn(eventData, ctx);
      }
      return result;
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    getTool(name: string) {
      return tools.find((t) => t.name === name);
    },
    get tools() {
      return tools;
    },
    get commands() {
      return commands;
    },
  };
}

function createMockContext(overrides: Record<string, any> = {}) {
  return {
    cwd: overrides.cwd ?? "/tmp/test",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tools-manager", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tools-mgr-test-"));
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("registration", () => {
    it("registers 4 commands", () => {
      expect(mock.commands.size).toBe(4);
      expect(mock.getCommand("tools")).toBeDefined();
      expect(mock.getCommand("tools-enable")).toBeDefined();
      expect(mock.getCommand("tools-disable")).toBeDefined();
      expect(mock.getCommand("tools-reset")).toBeDefined();
    });

    it("registers 1 tool", () => {
      expect(mock.tools.length).toBe(1);
      expect(mock.getTool("manage_tools")).toBeDefined();
    });
  });

  describe("session_start", () => {
    it("loads config and sets status when tools disabled", async () => {
      const configPath = join(tmpDir, ".pi-tool-config.json");
      await writeFile(
        configPath,
        JSON.stringify({ disabledTools: ["bash", "write"] }),
      );

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "tools",
        "tools: 2 disabled",
      );
      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "tool-restrictions",
        }),
        { triggerTurn: false },
      );
    });

    it("does nothing when no config file", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });
  });

  describe("tool_call interception", () => {
    it("blocks disabled tools", async () => {
      // Set up config with disabled tool
      await writeFile(
        join(tmpDir, ".pi-tool-config.json"),
        JSON.stringify({ disabledTools: ["write"] }),
      );
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      const result = await mock.emit("tool_call", { toolName: "write" }, ctx);

      expect(result).toEqual(
        expect.objectContaining({
          block: true,
          reason: expect.stringContaining("disabled"),
        }),
      );
    });

    it("allows non-disabled tools", async () => {
      await writeFile(
        join(tmpDir, ".pi-tool-config.json"),
        JSON.stringify({ disabledTools: ["write"] }),
      );
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      const result = await mock.emit("tool_call", { toolName: "read" }, ctx);

      expect(result).toBeUndefined();
    });
  });

  describe("/tools command", () => {
    it("shows all enabled message when no disabled tools", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      await mock.getCommand("tools")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("All tools are enabled"),
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("/tools-disable command", () => {
    it("disables a tool and saves config", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      await mock.getCommand("tools-disable")!.handler("bash", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Disabled tool: bash", "info");

      // Verify persisted
      const content = await readFile(
        join(tmpDir, ".pi-tool-config.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.disabledTools).toContain("bash");
    });

    it("warns on empty args", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("tools-disable")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
    });
  });

  describe("/tools-enable command", () => {
    it("enables a previously disabled tool", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      await mock.getCommand("tools-disable")!.handler("bash", ctx);
      await mock.getCommand("tools-enable")!.handler("bash", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Enabled tool: bash", "info");

      const content = await readFile(
        join(tmpDir, ".pi-tool-config.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.disabledTools).not.toContain("bash");
    });
  });

  describe("/tools-reset command", () => {
    it("enables all tools", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      await mock.getCommand("tools-disable")!.handler("bash", ctx);
      await mock.getCommand("tools-disable")!.handler("write", ctx);
      await mock.getCommand("tools-reset")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "All tools re-enabled",
        "info",
      );
    });
  });

  describe("manage_tools tool", () => {
    it("lists disabled tools", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      await mock.getCommand("tools-disable")!.handler("bash", ctx);

      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", { action: "list" });

      expect(result.content[0].text).toContain("bash");
    });

    it("enables a tool", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      await mock.getCommand("tools-disable")!.handler("write", ctx);

      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", {
        action: "enable",
        tool_name: "write",
      });

      expect(result.content[0].text).toContain("Enabled");
    });

    it("disables a tool", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", {
        action: "disable",
        tool_name: "edit",
      });

      expect(result.content[0].text).toContain("Disabled");
    });

    it("resets all", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", { action: "reset" });

      expect(result.content[0].text).toContain("re-enabled");
    });

    it("errors on enable without tool_name", async () => {
      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", { action: "enable" });

      expect(result.content[0].text).toContain("Error");
    });

    it("errors on unknown action", async () => {
      const tool = mock.getTool("manage_tools")!;
      const result = await tool.execute("call-1", { action: "nope" });

      expect(result.content[0].text).toContain("Unknown action");
    });
  });
});
