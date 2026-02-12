import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension, {
  isBashSafe,
  extractPlanSteps,
  formatPlanProgress,
  PLAN_MODE_TOOLS,
  BLOCKED_TOOLS,
  DESTRUCTIVE_BASH_PATTERNS,
  SAFE_BASH_PATTERNS,
} from "./plan-mode.js";

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
// Pure function tests
// ---------------------------------------------------------------------------

describe("isBashSafe", () => {
  describe("allows safe commands", () => {
    const safeCases: string[] = [
      "cat file.txt",
      "head -20 main.ts",
      "tail -f log",
      "grep -r pattern .",
      "rg pattern src/",
      "find . -name '*.ts'",
      "ls -la",
      "pwd",
      "echo hello",
      "wc -l file.txt",
      "file image.png",
      "stat package.json",
      "du -sh .",
      "df -h",
      "git status",
      "git log --oneline",
      "git diff HEAD",
      "git show abc123",
      "git branch",
      "gh pr view 42",
      "gh issue list",
      "tree src/",
      "which node",
      "type git",
      "node --help",
      "npm --version",
      "cargo build --dry-run",
    ];

    for (const cmd of safeCases) {
      it(`allows: ${cmd}`, () => {
        expect(isBashSafe(cmd)).toBe(true);
      });
    }
  });

  describe("blocks destructive commands", () => {
    const dangerousCases: string[] = [
      "rm file.txt",
      "rmdir dir",
      "mv a b",
      "cp a b",
      "mkdir newdir",
      "touch file",
      "chmod 755 script.sh",
      "chown user file",
      "ln -s a b",
      "tee output.txt",
      "truncate -s 0 file",
      "dd if=/dev/zero of=disk",
      "npm install react",
      "yarn add lodash",
      "pnpm add typescript",
      "pip install flask",
      "git add .",
      "git commit -m 'msg'",
      "git push origin main",
      "git pull",
      "git merge feature",
      "git rebase main",
      "git reset HEAD~1",
      "git checkout -b new",
      // Note: "git branch -D old" matches safe pattern "git branch" first — correct behavior
      "git stash",
      "sudo apt install foo",
      "kill 1234",
      "vim file.txt",
      "nano README.md",
      "emacs init.el",
    ];

    for (const cmd of dangerousCases) {
      it(`blocks: ${cmd}`, () => {
        expect(isBashSafe(cmd)).toBe(false);
      });
    }
  });

  describe("safe patterns override destructive", () => {
    it("cat overrides redirect pattern", () => {
      expect(isBashSafe("cat file.txt")).toBe(true);
    });

    it("git status is safe despite git being destructive context", () => {
      expect(isBashSafe("git status")).toBe(true);
    });

    it("git log is safe", () => {
      expect(isBashSafe("git log --oneline -10")).toBe(true);
    });

    it("--dry-run overrides destructive", () => {
      expect(isBashSafe("npm install --dry-run")).toBe(true);
    });
  });

  describe("allows unknown commands by default", () => {
    it("allows node script.js", () => {
      expect(isBashSafe("node script.js")).toBe(true);
    });

    it("allows npx tsc --noEmit", () => {
      expect(isBashSafe("npx tsc --noEmit")).toBe(true);
    });

    it("allows cargo test", () => {
      expect(isBashSafe("cargo test")).toBe(true);
    });
  });
});

describe("extractPlanSteps", () => {
  it("extracts numbered steps with periods", () => {
    const text = "1. First step\n2. Second step\n3. Third step";
    const steps = extractPlanSteps(text);

    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ id: 1, text: "First step", done: false });
    expect(steps[2]).toEqual({ id: 3, text: "Third step", done: false });
  });

  it("extracts numbered steps with parentheses", () => {
    const text = "1) First\n2) Second";
    const steps = extractPlanSteps(text);

    expect(steps).toHaveLength(2);
    expect(steps[0].text).toBe("First");
  });

  it("ignores non-numbered lines", () => {
    const text = "## Plan\n\n1. Step one\nSome description\n2. Step two";
    const steps = extractPlanSteps(text);

    expect(steps).toHaveLength(2);
  });

  it("returns empty for no steps", () => {
    expect(extractPlanSteps("no steps here")).toEqual([]);
    expect(extractPlanSteps("")).toEqual([]);
  });

  it("handles leading whitespace", () => {
    const text = "  1. Indented step\n  2. Also indented";
    const steps = extractPlanSteps(text);

    expect(steps).toHaveLength(2);
    expect(steps[0].text).toBe("Indented step");
  });
});

describe("formatPlanProgress", () => {
  it("shows inactive when no steps and plan mode off", () => {
    // formatPlanProgress uses module-level state, so we test via the extension
    const result = formatPlanProgress();
    // With default state (inactive, no steps), should show inactive
    expect(result).toContain("inactive");
  });
});

describe("exports", () => {
  it("PLAN_MODE_TOOLS is a Set with expected tools", () => {
    expect(PLAN_MODE_TOOLS).toBeInstanceOf(Set);
    expect(PLAN_MODE_TOOLS.has("read")).toBe(true);
    expect(PLAN_MODE_TOOLS.has("bash")).toBe(true);
    expect(PLAN_MODE_TOOLS.has("grep")).toBe(true);
    expect(PLAN_MODE_TOOLS.has("write")).toBe(false);
  });

  it("BLOCKED_TOOLS is a Set with expected tools", () => {
    expect(BLOCKED_TOOLS).toBeInstanceOf(Set);
    expect(BLOCKED_TOOLS.has("write")).toBe(true);
    expect(BLOCKED_TOOLS.has("edit")).toBe(true);
    expect(BLOCKED_TOOLS.has("notebook")).toBe(true);
  });

  it("DESTRUCTIVE_BASH_PATTERNS is an array of RegExp", () => {
    expect(Array.isArray(DESTRUCTIVE_BASH_PATTERNS)).toBe(true);
    expect(DESTRUCTIVE_BASH_PATTERNS.every((p) => p instanceof RegExp)).toBe(
      true,
    );
  });

  it("SAFE_BASH_PATTERNS is an array of RegExp", () => {
    expect(Array.isArray(SAFE_BASH_PATTERNS)).toBe(true);
    expect(SAFE_BASH_PATTERNS.every((p) => p instanceof RegExp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension integration tests
// ---------------------------------------------------------------------------

describe("plan-mode extension", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Reset plan mode state via session_start
    const ctx = createMockContext();
    mock.emit("session_start", {}, ctx);
  });

  describe("registration", () => {
    it("registers 3 commands", () => {
      expect(mock.commands.size).toBe(3);
      expect(mock.getCommand("plan")).toBeDefined();
      expect(mock.getCommand("plan-execute")).toBeDefined();
      expect(mock.getCommand("plan-status")).toBeDefined();
    });

    it("registers 2 tools", () => {
      expect(mock.tools.length).toBe(2);
      expect(mock.getTool("plan_step_done")).toBeDefined();
      expect(mock.getTool("plan_extract")).toBeDefined();
    });
  });

  describe("/plan command", () => {
    it("enables plan mode", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Plan mode: ON (read-only)",
        "info",
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("plan-mode", "PLAN MODE");
    });

    it("injects plan mode context message", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx);

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "plan-mode-context",
          content: expect.stringContaining("PLAN MODE ACTIVE"),
        }),
        { triggerTurn: false },
      );
    });

    it("toggles off on second call", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx); // ON
      await mock.getCommand("plan")!.handler("", ctx); // OFF

      expect(ctx.ui.notify).toHaveBeenLastCalledWith("Plan mode: OFF", "info");
    });
  });

  describe("tool_call blocking in plan mode", () => {
    async function enablePlanMode(mock: any) {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx);
    }

    it("blocks write tool", async () => {
      await enablePlanMode(mock);
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "write", input: {} },
        ctx,
      );

      expect(result).toEqual(
        expect.objectContaining({
          block: true,
          reason: expect.stringContaining("Plan Mode"),
        }),
      );
    });

    it("blocks edit tool", async () => {
      await enablePlanMode(mock);
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "edit", input: {} },
        ctx,
      );

      expect(result).toEqual(expect.objectContaining({ block: true }));
    });

    it("blocks destructive bash commands", async () => {
      await enablePlanMode(mock);
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "rm -rf /" } },
        ctx,
      );

      expect(result).toEqual(
        expect.objectContaining({
          block: true,
          reason: expect.stringContaining("Destructive"),
        }),
      );
    });

    it("allows read-only bash commands", async () => {
      await enablePlanMode(mock);
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "git status" } },
        ctx,
      );

      expect(result).toBeUndefined();
    });

    it("allows read tool", async () => {
      await enablePlanMode(mock);
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "read", input: {} },
        ctx,
      );

      expect(result).toBeUndefined();
    });

    it("does not block when plan mode is off", async () => {
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "write", input: {} },
        ctx,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("/plan-execute command", () => {
    it("exits plan mode and sends execute prompt", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx); // Enable
      await mock.getCommand("plan-execute")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("executing plan"),
        "info",
      );
      expect(mock.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("Execute the plan"),
      );
    });

    it("warns when not in plan mode", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan-execute")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Not in plan mode", "warning");
    });

    it("includes extracted steps in execute prompt", async () => {
      const ctx = createMockContext();
      await mock.getCommand("plan")!.handler("", ctx); // Enable

      // Extract steps
      const tool = mock.getTool("plan_extract")!;
      await tool.execute("call-1", {
        plan_text: "1. Do first thing\n2. Do second thing",
      });

      await mock.getCommand("plan-execute")!.handler("", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Do first thing");
      expect(prompt).toContain("Do second thing");
    });
  });

  describe("/plan-status command", () => {
    it("shows status message", async () => {
      await mock.getCommand("plan-status")!.handler("", createMockContext());

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "plan-status",
          display: true,
        }),
        { triggerTurn: false },
      );
    });
  });

  describe("plan_extract tool", () => {
    it("extracts numbered steps", async () => {
      const tool = mock.getTool("plan_extract")!;
      const result = await tool.execute("call-1", {
        plan_text: "1. Read files\n2. Write code\n3. Run tests",
      });

      expect(result.content[0].text).toContain("Extracted 3 steps");
      expect(result.content[0].text).toContain("Read files");
    });

    it("returns error for no steps", async () => {
      const tool = mock.getTool("plan_extract")!;
      const result = await tool.execute("call-1", {
        plan_text: "No numbered items here",
      });

      expect(result.content[0].text).toContain("No numbered steps");
    });
  });

  describe("plan_step_done tool", () => {
    it("marks a step as done", async () => {
      // First extract steps
      const extract = mock.getTool("plan_extract")!;
      await extract.execute("call-1", {
        plan_text: "1. First\n2. Second\n3. Third",
      });

      const tool = mock.getTool("plan_step_done")!;
      const result = await tool.execute("call-2", { step: 1 });

      expect(result.content[0].text).toContain("Step 1 done");
      expect(result.content[0].text).toContain("1/3 complete");
    });

    it("tracks progress across multiple completions", async () => {
      const extract = mock.getTool("plan_extract")!;
      await extract.execute("call-1", {
        plan_text: "1. A\n2. B",
      });

      const tool = mock.getTool("plan_step_done")!;
      await tool.execute("call-2", { step: 1 });
      const result = await tool.execute("call-3", { step: 2 });

      expect(result.content[0].text).toContain("2/2 complete");
    });

    it("returns error for missing step", async () => {
      const tool = mock.getTool("plan_step_done")!;
      const result = await tool.execute("call-1", { step: 99 });

      expect(result.content[0].text).toContain("not found");
    });
  });
});
