import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import initExtension, { type Todo } from "./todo.js";

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

describe("todo", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "todo-test-"));
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Initialize state via session_start
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("registration", () => {
    it("registers 1 command", () => {
      expect(mock.commands.size).toBe(1);
      expect(mock.getCommand("todos")).toBeDefined();
    });

    it("registers 1 tool", () => {
      expect(mock.tools.length).toBe(1);
      expect(mock.getTool("todo")).toBeDefined();
    });
  });

  describe("todo tool — list", () => {
    it("returns empty message when no todos", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", { action: "list" });

      expect(result.content[0].text).toContain("No todos");
    });
  });

  describe("todo tool — add", () => {
    it("adds a todo", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", {
        action: "add",
        text: "Write tests",
      });

      expect(result.content[0].text).toContain("Added todo #1");
      expect(result.content[0].text).toContain("Write tests");
    });

    it("assigns incrementing IDs", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "First" });
      const result = await tool.execute("call-2", {
        action: "add",
        text: "Second",
      });

      expect(result.content[0].text).toContain("#2");
    });

    it("errors without text", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", { action: "add" });

      expect(result.content[0].text).toContain("Error");
    });

    it("persists to file", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", {
        action: "add",
        text: "Persistent todo",
      });

      const content = await readFile(join(tmpDir, ".pi-todos.json"), "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.todos).toHaveLength(1);
      expect(parsed.todos[0].text).toBe("Persistent todo");
    });
  });

  describe("todo tool — toggle", () => {
    it("marks a todo as done", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "Task" });
      const result = await tool.execute("call-2", {
        action: "toggle",
        id: 1,
      });

      expect(result.content[0].text).toContain("completed");
    });

    it("can reopen a completed todo", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "Task" });
      await tool.execute("call-2", { action: "toggle", id: 1 });
      const result = await tool.execute("call-3", {
        action: "toggle",
        id: 1,
      });

      expect(result.content[0].text).toContain("reopened");
    });

    it("errors for missing todo", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", {
        action: "toggle",
        id: 999,
      });

      expect(result.content[0].text).toContain("not found");
    });

    it("errors without id", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", { action: "toggle" });

      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("todo tool — clear", () => {
    it("clears all todos", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "A" });
      await tool.execute("call-2", { action: "add", text: "B" });
      const result = await tool.execute("call-3", { action: "clear" });

      expect(result.content[0].text).toContain("Cleared 2");
    });

    it("list shows empty after clear", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "A" });
      await tool.execute("call-2", { action: "clear" });
      const result = await tool.execute("call-3", { action: "list" });

      expect(result.content[0].text).toContain("No todos");
    });
  });

  describe("todo tool — unknown action", () => {
    it("returns error for unknown action", async () => {
      const tool = mock.getTool("todo")!;
      const result = await tool.execute("call-1", { action: "nope" });

      expect(result.content[0].text).toContain("Unknown action");
    });
  });

  describe("/todos command", () => {
    it("shows todos when present", async () => {
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "Task A" });

      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("todos")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "todos",
          content: expect.stringContaining("Task A"),
        }),
        { triggerTurn: false },
      );
    });

    it("shows notification when no todos", async () => {
      const ctx = createMockContext({ cwd: tmpDir });
      await mock.getCommand("todos")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No todos"),
        "info",
      );
    });
  });

  describe("session_start", () => {
    it("shows pending count in status bar", async () => {
      // Add a todo first
      const tool = mock.getTool("todo")!;
      await tool.execute("call-1", { action: "add", text: "Pending" });

      // Re-init to trigger session_start reload
      const mock2 = createMockExtensionAPI();
      initExtension(mock2.api as any);
      const ctx = createMockContext({ cwd: tmpDir });
      await mock2.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "todos",
        "todos: 1 pending",
      );
    });
  });
});
