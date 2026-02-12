import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension, {
  checkCommand,
  DESTRUCTIVE_PATTERNS,
  SAFE_OVERRIDES,
} from "./permission-gate.js";

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
    cwd: "/tmp/test",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests — checkCommand
// ---------------------------------------------------------------------------

describe("checkCommand", () => {
  describe("blocks destructive commands", () => {
    const dangerousCases: [string, string][] = [
      ["rm -rf /", "recursive delete"],
      ["rm -f file.txt", "force delete"],
      ["sudo apt install foo", "apt modification"],
      ["git push --force", "git force push"],
      ["git reset --hard HEAD~1", "git hard reset"],
      ["git clean -fd", "git clean force"],
      ["git branch -D feature", "git delete branch"],
      ["git rebase main", "git rebase"],
      ["npm install foo", "npm modification"],
      ["yarn add react", "yarn modification"],
      ["pip install flask", "pip modification"],
      ["kill -9 1234", "force kill"],
      ["killall node", "kill all"],
      ["vim file.txt", "interactive editor"],
      ["nano README.md", "interactive editor"],
      ["docker rm container", "docker cleanup"],
      ["kubectl delete pod foo", "kubectl delete"],
      ["chmod 777 file", "change permissions"],
      ["dd if=/dev/zero of=/dev/sda", "disk dump"],
      ["brew install go", "brew modification"],
      ["systemctl restart nginx", "systemctl"],
      [": > /etc/passwd", "truncate via redirect"],
    ];

    for (const [cmd, expectedLabel] of dangerousCases) {
      it(`blocks: ${cmd} → ${expectedLabel}`, () => {
        expect(checkCommand(cmd)).toBe(expectedLabel);
      });
    }
  });

  describe("allows safe commands", () => {
    const safeCases: string[] = [
      "ls -la",
      "git status",
      "git log --oneline",
      "git diff HEAD",
      "cat file.txt",
      "grep -r pattern .",
      "rg pattern",
      "tree src/",
      "echo hello",
      "printf '%s' test",
      "which node",
      "node --version",
      "npm test",
      "cargo build --dry-run",
    ];

    for (const cmd of safeCases) {
      it(`allows: ${cmd}`, () => {
        expect(checkCommand(cmd)).toBeNull();
      });
    }
  });

  describe("safe overrides take priority", () => {
    it("echo with rm inside is safe", () => {
      expect(checkCommand("echo rm -rf /")).toBeNull();
    });

    it("grep with sudo in pattern is safe", () => {
      expect(checkCommand("grep sudo /etc/passwd")).toBeNull();
    });

    it("--dry-run overrides destructive pattern", () => {
      expect(checkCommand("npm install --dry-run")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Extension integration tests
// ---------------------------------------------------------------------------

describe("permission-gate extension", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(() => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  describe("registration", () => {
    it("registers 1 command", () => {
      expect(mock.commands.size).toBe(1);
      expect(mock.getCommand("permission-gate")).toBeDefined();
    });

    it("registers no tools", () => {
      expect(mock.tools.length).toBe(0);
    });
  });

  describe("tool_call interception", () => {
    it("blocks dangerous bash commands", async () => {
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "rm -rf /" } },
        ctx,
      );

      expect(result).toEqual(
        expect.objectContaining({
          block: true,
          reason: expect.stringContaining("permission-gate"),
        }),
      );
    });

    it("allows safe bash commands", async () => {
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "ls -la" } },
        ctx,
      );

      expect(result).toBeUndefined();
    });

    it("ignores non-bash tools", async () => {
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "read", input: { path: "/etc/passwd" } },
        ctx,
      );

      expect(result).toBeUndefined();
    });

    it("ignores empty commands", async () => {
      const ctx = createMockContext();
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "" } },
        ctx,
      );

      expect(result).toBeUndefined();
    });
  });

  describe("/permission-gate command", () => {
    it("toggles gate off then on", async () => {
      const ctx = createMockContext();

      // Disable
      await mock.getCommand("permission-gate")!.handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("disabled"),
        "info",
      );

      // When disabled, dangerous commands pass through
      const result = await mock.emit(
        "tool_call",
        { toolName: "bash", input: { command: "rm -rf /" } },
        ctx,
      );
      expect(result).toBeUndefined();

      // Re-enable
      await mock.getCommand("permission-gate")!.handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("enabled"),
        "info",
      );
    });
  });

  describe("session_start", () => {
    it("sets status bar", async () => {
      const ctx = createMockContext();
      await mock.emit("session_start", {}, ctx);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "permission-gate",
        "gate: on",
      );
    });
  });

  describe("exports", () => {
    it("exports DESTRUCTIVE_PATTERNS array", () => {
      expect(Array.isArray(DESTRUCTIVE_PATTERNS)).toBe(true);
      expect(DESTRUCTIVE_PATTERNS.length).toBeGreaterThan(20);
    });

    it("exports SAFE_OVERRIDES array", () => {
      expect(Array.isArray(SAFE_OVERRIDES)).toBe(true);
      expect(SAFE_OVERRIDES.length).toBeGreaterThan(5);
    });
  });
});
