import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./git-checkpoint.js";

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
// Stash list fixtures
// ---------------------------------------------------------------------------

const STASH_OUTPUT = [
  "stash@{0}: On main: pi-checkpoint turn-3 2025-01-15_143022",
  "stash@{1}: On main: manual save",
  "stash@{2}: On main: pi-checkpoint turn-1 2025-01-15_140000",
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git-checkpoint", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("checkpoint")).toBeDefined();
      expect(mock.getCommand("checkpoint-restore")).toBeDefined();
    });

    it("registers 2 tools", () => {
      expect(mock.tools.length).toBe(2);
      expect(mock.getTool("git_checkpoint_list")).toBeDefined();
      expect(mock.getTool("git_checkpoint_restore")).toBeDefined();
    });
  });

  describe("turn_end checkpoint creation", () => {
    it("creates a stash checkpoint when dirty tree", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" }) // rev-parse
        .mockResolvedValueOnce({ stdout: " M file.ts\n" }) // status --porcelain
        .mockResolvedValueOnce({ stdout: "" }) // stash push
        .mockResolvedValueOnce({ stdout: "" }); // stash pop

      await mock.emit("turn_end", {}, ctx);

      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          expect.stringContaining("pi-checkpoint"),
        ],
        { cwd: "/tmp/test" },
      );
      expect(mock.api.exec).toHaveBeenCalledWith("git", ["stash", "pop"], {
        cwd: "/tmp/test",
      });
    });

    it("skips when not a git repo", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockResolvedValueOnce({ stdout: "" }); // rev-parse returns empty

      await mock.emit("turn_end", {}, ctx);

      // Only rev-parse called, no stash
      expect(mock.api.exec).toHaveBeenCalledTimes(1);
    });

    it("skips when tree is clean", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" }) // rev-parse
        .mockResolvedValueOnce({ stdout: "" }); // status --porcelain (clean)

      await mock.emit("turn_end", {}, ctx);

      expect(mock.api.exec).toHaveBeenCalledTimes(2);
    });

    it("handles stash errors gracefully", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" })
        .mockResolvedValueOnce({ stdout: " M file.ts\n" })
        .mockRejectedValueOnce(new Error("stash failed"));

      // Should not throw
      await mock.emit("turn_end", {}, ctx);
    });
  });

  describe("session_start", () => {
    it("shows checkpoint count in status bar", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" }) // rev-parse
        .mockResolvedValueOnce({ stdout: STASH_OUTPUT }); // stash list

      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "checkpoint",
        "checkpoints: 2",
      );
    });

    it("skips status when not a git repo", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockResolvedValueOnce({ stdout: "" });

      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });
  });

  describe("/checkpoint command", () => {
    it("lists checkpoints", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" })
        .mockResolvedValueOnce({ stdout: STASH_OUTPUT });

      await mock.getCommand("checkpoint")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "checkpoint-list",
          content: expect.stringContaining("2"),
        }),
        { triggerTurn: false },
      );
    });

    it("shows message when no checkpoints", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" })
        .mockResolvedValueOnce({ stdout: "" });

      await mock.getCommand("checkpoint")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "No checkpoints found",
        "info",
      );
    });

    it("warns when not a git repo", async () => {
      const ctx = createMockContext();
      mock.api.exec.mockResolvedValueOnce({ stdout: "" });

      await mock.getCommand("checkpoint")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Not a git repository",
        "warning",
      );
    });
  });

  describe("/checkpoint-restore command", () => {
    it("restores latest checkpoint", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" }) // isGitRepo
        .mockResolvedValueOnce({ stdout: STASH_OUTPUT }) // listCheckpoints
        .mockResolvedValueOnce({ stdout: "" }); // stash apply

      await mock.getCommand("checkpoint-restore")!.handler("", ctx);

      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        ["stash", "apply", "stash@{0}"],
        { cwd: "/tmp/test" },
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Restored"),
        "info",
      );
    });

    it("restores specific checkpoint by index", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" })
        .mockResolvedValueOnce({ stdout: STASH_OUTPUT })
        .mockResolvedValueOnce({ stdout: "" });

      await mock.getCommand("checkpoint-restore")!.handler("2", ctx);

      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        ["stash", "apply", "stash@{2}"],
        { cwd: "/tmp/test" },
      );
    });

    it("handles restore failure", async () => {
      const ctx = createMockContext();
      mock.api.exec
        .mockResolvedValueOnce({ stdout: "true\n" })
        .mockResolvedValueOnce({ stdout: STASH_OUTPUT })
        .mockRejectedValueOnce(new Error("conflict"));

      await mock.getCommand("checkpoint-restore")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Failed"),
        "error",
      );
    });
  });

  describe("git_checkpoint_list tool", () => {
    it("lists checkpoints", async () => {
      mock.api.exec.mockResolvedValueOnce({ stdout: STASH_OUTPUT });

      const tool = mock.getTool("git_checkpoint_list")!;
      const result = await tool.execute("call-1", {}, undefined, undefined, {
        cwd: "/tmp/test",
      });

      expect(result.content[0].text).toContain("2 checkpoint(s)");
    });

    it("returns empty message when no checkpoints", async () => {
      mock.api.exec.mockResolvedValueOnce({ stdout: "" });

      const tool = mock.getTool("git_checkpoint_list")!;
      const result = await tool.execute("call-1", {}, undefined, undefined, {
        cwd: "/tmp/test",
      });

      expect(result.content[0].text).toContain("No checkpoints");
    });
  });

  describe("git_checkpoint_restore tool", () => {
    it("restores by index", async () => {
      mock.api.exec.mockResolvedValueOnce({ stdout: "" });

      const tool = mock.getTool("git_checkpoint_restore")!;
      const result = await tool.execute(
        "call-1",
        { index: 2 },
        undefined,
        undefined,
        { cwd: "/tmp/test" },
      );

      expect(result.content[0].text).toContain("Restored");
      expect(mock.api.exec).toHaveBeenCalledWith(
        "git",
        ["stash", "apply", "stash@{2}"],
        { cwd: "/tmp/test" },
      );
    });

    it("handles restore failure", async () => {
      mock.api.exec.mockRejectedValueOnce(new Error("conflict"));

      const tool = mock.getTool("git_checkpoint_restore")!;
      const result = await tool.execute(
        "call-1",
        { index: 99 },
        undefined,
        undefined,
        { cwd: "/tmp/test" },
      );

      expect(result.content[0].text).toContain("Failed");
    });
  });
});
