import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import initExtension from "./custom-compaction.js";

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

describe("custom-compaction", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "compact-test-"));
    mock = createMockExtensionAPI();

    // Stub fetch to prevent real network calls; Graphiti unavailable by default
    originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no graphiti")));

    initExtension(mock.api as any);
  });

  afterEach(async () => {
    vi.stubGlobal("fetch", originalFetch);
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("registration", () => {
    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("compact-save")).toBeDefined();
      expect(mock.getCommand("compact-config")).toBeDefined();
    });

    it("registers 1 tool", () => {
      expect(mock.tools.length).toBe(1);
      expect(mock.getTool("compaction_context")).toBeDefined();
    });
  });

  describe("session_start", () => {
    it("loads saved state from file", async () => {
      const stateDir = join(tmpDir, ".pi");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "compaction-context.json"),
        JSON.stringify({
          keyDecisions: ["Use React"],
          currentGoals: ["Build MVP"],
          blockers: [],
          completedTasks: [],
          lastCompactedAt: null,
          compactionCount: 3,
        }),
      );

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "compaction",
        "compactions: 3",
      );
    });

    it("handles missing state file gracefully", async () => {
      // Use a fresh tmpDir with no state file
      const freshDir = await mkdtemp(join(tmpdir(), "compact-fresh-"));
      try {
        const ctx = createMockContext({ cwd: freshDir });
        await mock.emit("session_start", {}, ctx);

        // Should not throw — gracefully handles missing file
        // (module-level state may retain values from prior tests,
        //  but no error should occur)
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });

    it("warns when no Graphiti and no local state", async () => {
      const freshDir = await mkdtemp(join(tmpdir(), "compact-warn-"));
      try {
        // Re-init extension so module-level state resets compactionCount
        const freshMock = createMockExtensionAPI();
        vi.stubGlobal(
          "fetch",
          vi.fn().mockRejectedValue(new Error("no graphiti")),
        );
        initExtension(freshMock.api as any);

        const ctx = createMockContext({ cwd: freshDir });
        await freshMock.emit("session_start", {}, ctx);

        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("no Graphiti connection"),
          "warning",
        );
      } finally {
        await rm(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe("compaction_context tool", () => {
    let tool: any;

    beforeEach(async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      tool = mock.getTool("compaction_context")!;
    });

    it("adds a goal", async () => {
      const result = await tool.execute("call-1", {
        action: "add_goal",
        text: "Ship v1",
      });

      expect(result.content[0].text).toContain("Added goal");
      expect(result.content[0].text).toContain("Ship v1");
    });

    it("adds a decision", async () => {
      const result = await tool.execute("call-1", {
        action: "add_decision",
        text: "Use TypeScript",
      });

      expect(result.content[0].text).toContain("Recorded decision");
    });

    it("adds a blocker", async () => {
      const result = await tool.execute("call-1", {
        action: "add_blocker",
        text: "API not ready",
      });

      expect(result.content[0].text).toContain("Added blocker");
    });

    it("completes a task and removes from goals", async () => {
      // Clear state first to isolate from other tests
      await tool.execute("call-0", { action: "clear" });

      await tool.execute("call-1", {
        action: "add_goal",
        text: "Write tests",
      });
      const result = await tool.execute("call-2", {
        action: "complete_task",
        text: "Write tests",
      });

      expect(result.content[0].text).toContain("Completed");

      // Verify goal was removed — only goal was "Write tests" which was completed
      const view = await tool.execute("call-3", { action: "view" });
      expect(view.content[0].text).not.toContain("### Current Goals");
    });

    it("views current context", async () => {
      await tool.execute("call-1", {
        action: "add_goal",
        text: "Build API",
      });
      const result = await tool.execute("call-2", { action: "view" });

      expect(result.content[0].text).toContain("Build API");
      expect(result.content[0].text).toContain("Session Context");
    });

    it("clears all context", async () => {
      await tool.execute("call-1", {
        action: "add_goal",
        text: "Something",
      });
      const result = await tool.execute("call-2", { action: "clear" });

      expect(result.content[0].text).toContain("Cleared");
    });

    it("errors on add_goal without text", async () => {
      const result = await tool.execute("call-1", { action: "add_goal" });
      expect(result.content[0].text).toContain("Error");
    });

    it("errors on add_decision without text", async () => {
      const result = await tool.execute("call-1", {
        action: "add_decision",
      });
      expect(result.content[0].text).toContain("Error");
    });

    it("errors on add_blocker without text", async () => {
      const result = await tool.execute("call-1", {
        action: "add_blocker",
      });
      expect(result.content[0].text).toContain("Error");
    });

    it("errors on complete_task without text", async () => {
      const result = await tool.execute("call-1", {
        action: "complete_task",
      });
      expect(result.content[0].text).toContain("Error");
    });

    it("errors on unknown action", async () => {
      const result = await tool.execute("call-1", { action: "nope" });
      expect(result.content[0].text).toContain("Unknown action");
    });

    it("persists state to file", async () => {
      await tool.execute("call-1", {
        action: "add_goal",
        text: "Persistent goal",
      });

      const content = await readFile(
        join(tmpDir, ".pi", "compaction-context.json"),
        "utf-8",
      );
      const parsed = JSON.parse(content);
      expect(parsed.currentGoals).toContain("Persistent goal");
    });
  });

  describe("session_before_compact event", () => {
    it("increments compaction count and notifies", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      await mock.emit("session_before_compact", {}, ctx);

      // Compaction count depends on module-level state; just verify the pattern
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringMatching(/compaction #\d+/),
        "info",
      );
    });

    it("calls setPreamble when available", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      const setPreamble = vi.fn();
      await mock.emit("session_before_compact", { setPreamble }, ctx);

      expect(setPreamble).toHaveBeenCalledWith(
        expect.stringContaining("Session Context"),
      );
    });

    it("falls back to sendMessage when setPreamble not available", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);
      await mock.emit("session_before_compact", {}, ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "compaction-context",
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("/compact-config command", () => {
    it("shows compaction state", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      await mock.getCommand("compact-config")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "compaction-config",
          content: expect.stringContaining("Graphiti"),
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("/compact-save command", () => {
    it("saves state and notifies when graphiti unavailable", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.emit("session_start", {}, ctx);

      await mock.getCommand("compact-save")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("not available"),
        "warning",
      );
    });
  });
});
