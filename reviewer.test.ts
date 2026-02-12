import { describe, it, expect, vi, beforeEach } from "vitest";
import initExtension from "./reviewer.js";

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

describe("reviewer", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    // Reset module-level findings via session_start
    await mock.emit("session_start", {}, {});
  });

  describe("registration", () => {
    it("registers 2 commands", () => {
      expect(mock.commands.size).toBe(2);
      expect(mock.getCommand("review")).toBeDefined();
      expect(mock.getCommand("review-pr")).toBeDefined();
    });

    it("registers 2 tools", () => {
      expect(mock.tools.length).toBe(2);
      expect(mock.getTool("report_finding")).toBeDefined();
      expect(mock.getTool("submit_verdict")).toBeDefined();
    });
  });

  describe("session_start", () => {
    it("resets findings", async () => {
      // Report a finding first
      const tool = mock.getTool("report_finding")!;
      await tool.execute("call-1", {
        title: "Bug",
        body: "desc",
        priority: "P0",
        confidence: 0.9,
        file_path: "a.ts",
        line_start: 1,
        line_end: 5,
      });

      // Reset via session_start
      await mock.emit("session_start", {}, {});

      // Submit verdict should show 0 findings
      const verdict = mock.getTool("submit_verdict")!;
      const result = await verdict.execute("call-2", {
        correctness: "correct",
        explanation: "All good",
        confidence: 0.95,
      });

      expect(result.content[0].text).toContain("0 finding(s)");
    });
  });

  describe("report_finding tool", () => {
    it("records a P0 finding", async () => {
      const tool = mock.getTool("report_finding")!;
      const result = await tool.execute("call-1", {
        title: "Null pointer in login",
        body: "user.name accessed without null check",
        priority: "P0",
        confidence: 0.95,
        file_path: "src/auth.ts",
        line_start: 42,
        line_end: 45,
      });

      expect(result.content[0].text).toContain("Finding #1");
      expect(result.content[0].text).toContain("P0");
      expect(result.content[0].text).toContain("Critical");
      expect(result.content[0].text).toContain("src/auth.ts:42");
    });

    it("records multiple findings with incrementing count", async () => {
      const tool = mock.getTool("report_finding")!;

      await tool.execute("call-1", {
        title: "Bug 1",
        body: "desc",
        priority: "P1",
        confidence: 0.8,
        file_path: "a.ts",
        line_start: 1,
        line_end: 2,
      });

      const result = await tool.execute("call-2", {
        title: "Bug 2",
        body: "desc",
        priority: "P2",
        confidence: 0.7,
        file_path: "b.ts",
        line_start: 10,
        line_end: 15,
      });

      expect(result.content[0].text).toContain("Finding #2");
    });

    it("handles P3/info priority", async () => {
      const tool = mock.getTool("report_finding")!;
      const result = await tool.execute("call-1", {
        title: "Style nit",
        body: "naming",
        priority: "P3",
        confidence: 0.5,
        file_path: "x.ts",
        line_start: 1,
        line_end: 1,
      });

      expect(result.content[0].text).toContain("Info");
    });
  });

  describe("submit_verdict tool", () => {
    it("submits PASS verdict with no findings", async () => {
      const tool = mock.getTool("submit_verdict")!;
      const result = await tool.execute("call-1", {
        correctness: "correct",
        explanation: "Code looks correct.",
        confidence: 0.9,
      });

      expect(result.content[0].text).toContain("PASS");
      expect(result.content[0].text).toContain("0 finding(s)");
    });

    it("submits FAIL verdict with findings", async () => {
      const findingTool = mock.getTool("report_finding")!;
      await findingTool.execute("call-1", {
        title: "Critical bug",
        body: "description",
        priority: "P0",
        confidence: 0.95,
        file_path: "main.ts",
        line_start: 1,
        line_end: 10,
      });

      const tool = mock.getTool("submit_verdict")!;
      const result = await tool.execute("call-2", {
        correctness: "incorrect",
        explanation: "Has a critical bug.",
        confidence: 0.9,
      });

      expect(result.content[0].text).toContain("FAIL");
      expect(result.content[0].text).toContain("1 finding(s)");
    });

    it("displays formatted report via sendMessage", async () => {
      const findingTool = mock.getTool("report_finding")!;
      await findingTool.execute("call-1", {
        title: "Bug",
        body: "desc",
        priority: "P1",
        confidence: 0.8,
        file_path: "f.ts",
        line_start: 5,
        line_end: 10,
      });

      const tool = mock.getTool("submit_verdict")!;
      await tool.execute("call-2", {
        correctness: "incorrect",
        explanation: "Issues found.",
        confidence: 0.85,
      });

      expect(mock.api.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "review-verdict",
          display: true,
          content: expect.stringContaining("Review Verdict: FAIL"),
        }),
        { triggerTurn: false },
      );
    });

    it("resets findings after verdict", async () => {
      const findingTool = mock.getTool("report_finding")!;
      await findingTool.execute("call-1", {
        title: "Bug",
        body: "d",
        priority: "P2",
        confidence: 0.7,
        file_path: "a.ts",
        line_start: 1,
        line_end: 2,
      });

      const tool = mock.getTool("submit_verdict")!;
      await tool.execute("call-2", {
        correctness: "correct",
        explanation: "ok",
        confidence: 0.9,
      });

      // Second verdict should have 0 findings
      const result = await tool.execute("call-3", {
        correctness: "correct",
        explanation: "clean",
        confidence: 1.0,
      });

      expect(result.content[0].text).toContain("0 finding(s)");
    });
  });

  describe("/review command", () => {
    it("sends review prompt", async () => {
      const ctx = createMockContext();
      await mock.getCommand("review")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Starting code review...",
        "info",
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "reviewer",
        "review: active",
      );
      expect(mock.api.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining("CODE REVIEW"),
      );
    });

    it("includes target in prompt", async () => {
      const ctx = createMockContext();
      await mock.getCommand("review")!.handler("src/api.ts", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("src/api.ts");
    });

    it("includes review criteria", async () => {
      const ctx = createMockContext();
      await mock.getCommand("review")!.handler("", ctx);

      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("Provable impact");
      expect(prompt).toContain("Actionable");
    });
  });

  describe("/review-pr command", () => {
    it("sends PR review prompt", async () => {
      const ctx = createMockContext();
      await mock.getCommand("review-pr")!.handler("42", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Reviewing PR #42...", "info");
      const prompt = mock.api.sendUserMessage.mock.calls[0][0];
      expect(prompt).toContain("pull request #42");
      expect(prompt).toContain("gh pr diff 42");
    });

    it("warns on empty args", async () => {
      const ctx = createMockContext();
      await mock.getCommand("review-pr")!.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Usage"),
        "warning",
      );
      expect(mock.api.sendUserMessage).not.toHaveBeenCalled();
    });
  });
});
