import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./designer.js";

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

describe("designer", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("design")).toBeDefined();
      expect(mock.getCommand("design-review")).toBeDefined();
    });

    it("registers no tools", () => {
      expect(mock.tools.length).toBe(0);
    });
  });

  describe("/design command", () => {
    it("sends design prompt with task", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design")!.handler("Build a dashboard", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Starting design session...",
        "info",
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "designer",
        "designer: active",
      );
      expect(mock.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Build a dashboard"),
      );
    });

    it("includes anti-slop patterns", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design")!.handler("task", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Glassmorphism");
      expect(prompt).toContain("AI Slop Patterns");
    });

    it("includes project name from cwd", async () => {
      const ctx = createMockContext({ cwd: "/home/user/awesome-app" });
      await mock.getCommand("design")!.handler("task", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("awesome-app");
    });

    it("sends prompt without task when empty args", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design")!.handler("", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Ask the user what they want");
    });
  });

  describe("/design-review command", () => {
    it("sends review prompt with target", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design-review")!.handler("src/App.tsx", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Starting design review...",
        "info",
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "designer",
        "review: active",
      );
      expect(mock.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("src/App.tsx"),
      );
    });

    it("includes review checklist", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design-review")!.handler("target", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Visual Consistency");
      expect(prompt).toContain("Accessibility");
      expect(prompt).toContain("UX Completeness");
    });

    it("includes anti-slop patterns in review", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design-review")!.handler("target", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("AI Slop Patterns");
    });

    it("asks when no target specified", async () => {
      const ctx = createMockContext();
      await mock.getCommand("design-review")!.handler("", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Ask the user which files");
    });
  });
});
