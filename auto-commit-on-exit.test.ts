import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./auto-commit-on-exit.js";

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

describe("auto-commit-on-exit", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 1 command", () => {
      expect(mock.commands.size).toBe(1);
      expect(mock.getCommand("auto-commit")).toBeDefined();
    });

    it("registers 1 tool", () => {
      expect(mock.tools.length).toBe(1);
      expect(mock.getTool("auto_commit_status")).toBeDefined();
    });

    it("registers session_start, turn_end, and session_shutdown events", () => {
      const mock2 = createMockExtensionAPI();
      const events: string[] = [];
      const origOn = mock2.api.on.bind(mock2.api);
      mock2.api.on = (event: string, handler: Function) => {
        events.push(event);
        origOn(event, handler);
      };
      initExtension(mock2.api as any);
      expect(events).toContain("session_start");
      expect(events).toContain("turn_end");
      expect(events).toContain("session_shutdown");
    });
  });

  describe("session_start", () => {
    it("sets auto-commit status bar", async () => {
      const ctx = createMockContext();
      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "auto-commit",
        "auto-commit: on",
      );
    });
  });

  describe("turn_end", () => {
    it("tracks last git log output", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockResolvedValue({ stdout: "abc123 last commit msg\n" });

      await mock.emit("turn_end", {}, ctx);

      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        ["log", "--oneline", "-1"],
        { cwd: "/tmp/test" },
      );
    });

    it("handles non-git repo gracefully", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockRejectedValue(new Error("not a git repo"));

      // Should not throw
      await mock.emit("turn_end", {}, ctx);
    });
  });

  describe("session_shutdown", () => {
    it("auto-commits when there are dirty changes", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: " M file.ts\n" }) // git status
        .mockResolvedValueOnce({ stdout: "" }) // git add -u
        .mockResolvedValueOnce({ stdout: " file.ts | 1 +\n" }) // git diff --cached --stat
        .mockResolvedValueOnce({ stdout: "" }); // git commit

      await mock.emit("session_shutdown", {}, ctx);

      expect(mock.api.exec).toHaveBeenCalledWith("git", ["add", "-u"], {
        cwd: "/tmp/test",
      });
      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", expect.stringContaining("wip:")],
        { cwd: "/tmp/test" },
      );
    });

    it("skips commit when working tree is clean", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockResolvedValueOnce({ stdout: "" }); // git status

      await mock.emit("session_shutdown", {}, ctx);

      // Only git status was called, no add/commit
      expect(mock.api.exec).toHaveBeenCalledTimes(1);
    });

    it("skips commit when nothing is staged", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "?? untracked.ts\n" }) // git status
        .mockResolvedValueOnce({ stdout: "" }) // git add -u
        .mockResolvedValueOnce({ stdout: "" }); // git diff --cached --stat (nothing staged)

      await mock.emit("session_shutdown", {}, ctx);

      expect(mock.api.exec).toHaveBeenCalledTimes(3);
    });

    it("handles git errors gracefully", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockRejectedValue(new Error("git broken"));

      // Should not throw
      await mock.emit("session_shutdown", {}, ctx);
    });
  });

  describe("/auto-commit command", () => {
    it("toggles enabled state", async () => {
      const ctx = createMockContext();

      // First toggle: disable
      await mock.getCommand("auto-commit")!.handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
        "info",
      );

      // Second toggle: enable
      await mock.getCommand("auto-commit")!.handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("enabled"),
        "info",
      );
    });
  });

  describe("auto_commit_status tool", () => {
    it("returns current status", async () => {
      const tool = mock.getTool("auto_commit_status")!;
      const result = await tool.execute("call-1", {});

      expect(result.content[0].text).toContain("enabled");
    });

    it("can enable", async () => {
      const tool = mock.getTool("auto_commit_status")!;
      // First disable via command
      const ctx = createMockContext();
      await mock.getCommand("auto-commit")!.handler("", ctx);

      const result = await tool.execute("call-1", { action: "enable" });
      expect(result.content[0].text).toContain("enabled");
    });

    it("can disable", async () => {
      const tool = mock.getTool("auto_commit_status")!;
      const result = await tool.execute("call-1", { action: "disable" });
      expect(result.content[0].text).toContain("disabled");
    });

    it("skips auto-commit when disabled", async () => {
      const tool = mock.getTool("auto_commit_status")!;
      await tool.execute("call-1", { action: "disable" });

      const ctx = createMockContext();
      mock.api.exec.mockResolvedValueOnce({ stdout: " M file.ts\n" });

      await mock.emit("session_shutdown", {}, ctx);

      // Should not call git add/commit since disabled
      expect(mock.api.exec).not.toHaveBeenCalled();
    });
  });
});
