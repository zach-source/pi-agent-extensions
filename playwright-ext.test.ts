import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./playwright-ext.js";

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
    cwd: overrides.cwd ?? "/tmp/my-project",
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

describe("playwright-ext", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("playwright-ext")).toBeDefined();
      expect(mock.getCommand("playwright-ext-help")).toBeDefined();
    });

    it("registers no tools", () => {
      expect(mock.tools.length).toBe(0);
    });
  });

  describe("/playwright-ext command", () => {
    it("sends guide prompt with task", async () => {
      const ctx = createMockContext();
      await mock
        .getCommand("playwright-ext")!
        .handler("Test my Chrome extension", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Loading Playwright extensions guide...",
        "info",
      );
      expect(mock.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Test my Chrome extension"),
      );
    });

    it("includes all 6 guide sections", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext")!.handler("task", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Persistent Context");
      expect(prompt).toContain("CDP Attachment");
      expect(prompt).toContain("Recording Extensions");
      expect(prompt).toContain("Plugin Frameworks");
      expect(prompt).toContain("Python Packages");
      expect(prompt).toContain("Raspberry Pi");
    });

    it("includes code examples", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext")!.handler("task", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("launchPersistentContext");
      expect(prompt).toContain("--load-extension");
      expect(prompt).toContain("connectOverCDP");
    });

    it("includes project name from cwd", async () => {
      const ctx = createMockContext({ cwd: "/home/user/browser-tests" });
      await mock.getCommand("playwright-ext")!.handler("task", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("browser-tests");
    });

    it("asks user when no task provided", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext")!.handler("", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Ask the user what they need help with");
    });
  });

  describe("/playwright-ext-help command", () => {
    it("sends display-only message", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext-help")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "playwright-ext-help",
          display: "block",
        }),
        { triggerTurn: false },
      );
    });

    it("includes summary table content", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext-help")!.handler("", ctx);

      const msg = mock.api.sendMessage.mock.calls[0][0];
      expect(msg.content).toContain("launchPersistentContext");
      expect(msg.content).toContain("connectOverCDP");
      expect(msg.content).toContain("pytest-playwright");
      expect(msg.content).toContain("/playwright-ext");
    });

    it("does not trigger an agent turn", async () => {
      const ctx = createMockContext();
      await mock.getCommand("playwright-ext-help")!.handler("", ctx);

      expect(mock.api.sendUserMessage).not.toHaveBeenCalled();
    });
  });
});
