import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./reload-runtime.js";

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
      for (const fn of fns) await fn(eventData, ctx);
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
    cwd: "/tmp/test",
    reload: vi.fn(),
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

describe("reload-runtime", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 1 command", () => {
      expect(mock.commands.size).toBe(1);
      expect(mock.getCommand("reload-runtime")).toBeDefined();
    });

    it("registers 1 tool", () => {
      expect(mock.tools.length).toBe(1);
      expect(mock.getTool("reload_runtime")).toBeDefined();
    });
  });

  describe("/reload-runtime command", () => {
    it("calls ctx.reload() when available", async () => {
      const ctx = createMockContext();
      await mock.getCommand("reload-runtime")!.handler("", ctx);

      expect(ctx.reload).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Reloading runtime...",
        "info",
      );
    });

    it("warns when reload not supported", async () => {
      const ctx = createMockContext({ reload: undefined });
      await mock.getCommand("reload-runtime")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not supported"),
        "warning",
      );
    });
  });

  describe("reload_runtime tool", () => {
    it("queues follow-up command", async () => {
      const tool = mock.getTool("reload_runtime")!;
      const result = await tool.execute("call-1", {});

      expect(mock.api.sendUserMessage).toHaveBeenCalledWith("/reload-runtime", {
        deliverAs: "followUp",
      });
      expect(result.content[0].text).toContain("follow-up");
    });
  });
});
