/**
 * Integration tests for simple-harness against a real git repo.
 *
 * Tests exercise the extension end-to-end: /run, run_plan, turn_end auto-merge,
 * turn_end dispatch, /run:stop, /run:cleanup, dependency ordering.
 *
 * Note: tmux operations are mocked since CI environments don't have tmux.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  Text: class {
    constructor(
      public text: string,
      public x: number,
      public y: number,
    ) {}
  },
}));

import {
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  rm,
  writeFile,
  stat,
} from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  RUN_DIR,
  RUN_STATE_FILE,
  STOP_SIGNAL_FILE,
  RUN_WORKTREE_DIR,
  type RunState,
  deserializeRunState,
} from "./simple-harness.js";
import initExtension from "./simple-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
}

/** Mock tmux commands: track calls but don't actually create sessions. */
function createTmuxMock() {
  const activeSessions = new Set<string>();
  return {
    activeSessions,
    handler: async (
      cmd: string,
      args: string[],
      opts?: any,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd === "tmux") {
        const subCmd = args.find(
          (a) =>
            a === "new-session" ||
            a === "has-session" ||
            a === "kill-session" ||
            a === "list-sessions" ||
            a === "capture-pane" ||
            a === "send-keys",
        );

        if (subCmd === "new-session") {
          const sIdx = args.indexOf("-s");
          if (sIdx >= 0) activeSessions.add(args[sIdx + 1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (subCmd === "send-keys") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (subCmd === "has-session") {
          const tIdx = args.indexOf("-t");
          const name = tIdx >= 0 ? args[tIdx + 1] : "";
          return {
            stdout: "",
            stderr: "",
            exitCode: activeSessions.has(name) ? 0 : 1,
          };
        }
        if (subCmd === "kill-session") {
          const tIdx = args.indexOf("-t");
          if (tIdx >= 0) activeSessions.delete(args[tIdx + 1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (subCmd === "list-sessions") {
          return {
            stdout: Array.from(activeSessions).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (subCmd === "capture-pane") {
          return {
            stdout: "some output " + Date.now(),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // Fall through to real exec for non-tmux commands
      return null as any; // sentinel to use real exec
    },
  };
}

function createMockExtensionAPI(repoDir: string) {
  const handlers = new Map<string, Function[]>();
  const tools: Array<{ name: string; [k: string]: any }> = [];
  const commands = new Map<
    string,
    { description: string; handler: Function }
  >();
  const tmuxMock = createTmuxMock();

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
    exec: vi
      .fn()
      .mockImplementation(async (cmd: string, args: string[], opts?: any) => {
        // Try tmux mock first
        const tmuxResult = await tmuxMock.handler(cmd, args, opts);
        if (tmuxResult !== null) return tmuxResult;

        // Real exec for git and other commands
        const cwd = opts?.cwd || repoDir;
        try {
          const quotedArgs = args.map(
            (a: string) => `'${a.replace(/'/g, "'\\''")}'`,
          );
          const stdout = execSync(`${cmd} ${quotedArgs.join(" ")}`, {
            cwd,
            encoding: "utf-8",
            timeout: 10_000,
          });
          return { stdout, stderr: "", exitCode: 0 };
        } catch (e: any) {
          return {
            stdout: e.stdout?.toString() || "",
            stderr: e.stderr?.toString() || "",
            exitCode: e.status || 1,
          };
        }
      }),
  };

  return {
    api,
    tmuxMock,
    async emit(event: string, eventData: any, ctx: any) {
      const fns = handlers.get(event) ?? [];
      for (const fn of fns) {
        await fn(eventData, ctx);
      }
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    getTool(name: string) {
      return tools.find((t) => t.name === name);
    },
  };
}

function createMockContext(cwd: string) {
  return {
    cwd,
    isIdle: vi.fn().mockReturnValue(true),
    getContextUsage: vi.fn().mockReturnValue({
      tokens: 5000,
      contextWindow: 100_000,
      percent: 5,
    }),
    newSession: vi.fn(),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("simple-harness integration", () => {
  let baseDir: string;
  let repoDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "simple-harness-integ-"));

    // Create a basic git repo
    repoDir = join(baseDir, "repo");
    git(`init ${repoDir}`, baseDir);
    execSync(
      `echo '{"name":"test","devDependencies":{"vitest":"^3.0.0","typescript":"^5.0.0"}}' > package.json && echo '# Test Repo' > README.md && git add . && git commit -m "init"`,
      { cwd: repoDir, shell: "/bin/bash", encoding: "utf-8" },
    );
  }, 30_000);

  afterAll(async () => {
    // Clean up worktrees before removing
    try {
      execSync("git worktree prune", { cwd: repoDir, encoding: "utf-8" });
    } catch {
      /* repo may be gone */
    }
    await rm(baseDir, { recursive: true, force: true });
  }, 30_000);

  // Cleanup between tests
  beforeEach(async () => {
    // Remove .run/ directory if it exists
    try {
      await rm(join(repoDir, RUN_DIR), { recursive: true, force: true });
    } catch {
      /* doesn't exist */
    }
    // Force-remove worktrees first, then prune and delete branches
    try {
      const worktreeDir = join(repoDir, RUN_WORKTREE_DIR);
      const entries = await readdir(worktreeDir).catch(() => []);
      for (const entry of entries) {
        try {
          execSync(
            `git worktree remove --force '${join(worktreeDir, entry)}'`,
            { cwd: repoDir, encoding: "utf-8" },
          );
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* dir doesn't exist */
    }
    try {
      execSync("git worktree prune", { cwd: repoDir, encoding: "utf-8" });
      const branches = execSync("git branch --list 'pi-agent/*'", {
        cwd: repoDir,
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((b) => b.trim());
      for (const branch of branches) {
        execSync(`git branch -D '${branch}'`, {
          cwd: repoDir,
          encoding: "utf-8",
        });
      }
    } catch {
      /* no branches */
    }
    // Also remove .run/ again after worktree cleanup
    try {
      await rm(join(repoDir, RUN_DIR), { recursive: true, force: true });
    } catch {
      /* doesn't exist */
    }
  }, 30_000);

  it("/run returns a repo snapshot prompt via sendUserMessage", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("run")!;
    expect(cmd).toBeDefined();
    await cmd.handler("improve test coverage", ctx);

    // Should call sendUserMessage with the planning prompt
    expect(mock.api.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = mock.api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("Repository Snapshot");
    expect(prompt).toContain("improve test coverage");
    expect(prompt).toContain("run_plan");
    expect(prompt).toContain("developer");
    expect(prompt).toContain("tester");
  });

  it("/run rejects when a run is already active", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);

    // Start first run
    await mock.getCommand("run")!.handler("first objective", ctx);

    // Use run_plan to activate the loop
    const planTool = mock.getTool("run_plan")!;
    await planTool.execute("call-1", {
      tasks: [
        {
          name: "task-a",
          role: "developer",
          goals: ["Do something"],
          context: "ctx",
        },
      ],
    });

    // Try starting second run — should fail
    mock.api.sendMessage.mockClear();
    await mock.getCommand("run")!.handler("second objective", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already active"),
      }),
      expect.anything(),
    );
  });

  it("run_plan spawns workers and creates worktrees + goal files", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("add tests", ctx);

    const planTool = mock.getTool("run_plan")!;
    const result = await planTool.execute("call-1", {
      tasks: [
        {
          name: "unit-tests",
          role: "tester",
          goals: ["Write unit tests", "Verify coverage"],
          context: "Use vitest",
        },
        {
          name: "fix-lint",
          role: "developer",
          goals: ["Fix lint errors"],
          context: "Run eslint",
        },
      ],
    });

    const text = result.content[0].text;
    expect(text).toContain("Run Plan Accepted");
    expect(text).toContain("unit-tests");
    expect(text).toContain("fix-lint");

    // Goal files should exist in .run/
    const runDir = join(repoDir, RUN_DIR);
    const files = await readdir(runDir);
    expect(files).toContain("unit-tests.md");
    expect(files).toContain("fix-lint.md");

    // Goal file content should be correct
    const goalContent = await readFile(join(runDir, "unit-tests.md"), "utf-8");
    expect(goalContent).toContain("unit-tests");
    expect(goalContent).toContain("- [ ] Write unit tests");
    expect(goalContent).toContain("- [ ] Verify coverage");

    // Worktrees should exist
    const worktreeDir = join(repoDir, RUN_WORKTREE_DIR);
    const worktrees = await readdir(worktreeDir);
    expect(worktrees).toContain("unit-tests");
    expect(worktrees).toContain("fix-lint");

    // Branches should exist
    const branches = git("branch --list 'pi-agent/*'", repoDir);
    expect(branches).toContain("pi-agent/unit-tests");
    expect(branches).toContain("pi-agent/fix-lint");

    // State file should exist
    const stateContent = await readFile(join(repoDir, RUN_STATE_FILE), "utf-8");
    const state = deserializeRunState(stateContent);
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.sessions["unit-tests"]).toBeDefined();
    expect(state!.sessions["fix-lint"]).toBeDefined();
  }, 15_000);

  it("run_plan validates task names", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);

    const planTool = mock.getTool("run_plan")!;
    const result = await planTool.execute("call-1", {
      tasks: [
        {
          name: "Invalid Name",
          role: "developer",
          goals: ["goal"],
          context: "",
        },
      ],
    });

    expect(result.content[0].text).toContain("Plan error");
    expect(result.content[0].text).toContain("kebab-case");
  });

  it("run_plan validates roles", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);

    const planTool = mock.getTool("run_plan")!;
    const result = await planTool.execute("call-1", {
      tasks: [
        {
          name: "task-a",
          role: "analyst",
          goals: ["goal"],
          context: "",
        },
      ],
    });

    expect(result.content[0].text).toContain("Invalid role");
    expect(result.content[0].text).toContain("analyst");
  });

  it("run_plan validates dependency graph", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);

    const planTool = mock.getTool("run_plan")!;
    const result = await planTool.execute("call-1", {
      tasks: [
        {
          name: "task-a",
          role: "developer",
          goals: ["goal"],
          context: "",
          dependsOn: ["task-b"],
        },
        {
          name: "task-b",
          role: "developer",
          goals: ["goal"],
          context: "",
          dependsOn: ["task-a"],
        },
      ],
    });

    expect(result.content[0].text).toContain("cycle");
  });

  it("turn_end auto-merges completed workers", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("fix bugs", ctx);

    // Spawn one worker
    const planTool = mock.getTool("run_plan")!;
    await planTool.execute("call-1", {
      tasks: [
        {
          name: "fix-bug",
          role: "developer",
          goals: ["Fix the bug"],
          context: "",
        },
      ],
    });

    // Simulate the worker completing: commit a change in the worktree
    const worktreePath = resolve(repoDir, RUN_WORKTREE_DIR, "fix-bug");
    execSync(
      `echo "fixed" > bugfix.txt && git add . && git commit -m "fix bug"`,
      { cwd: worktreePath, shell: "/bin/bash", encoding: "utf-8" },
    );

    // Mark goal as complete in the goal file
    const goalPath = join(repoDir, RUN_DIR, "fix-bug.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent = goalContent.replace("- [ ] Fix the bug", "- [x] Fix the bug");
    await writeFile(goalPath, goalContent, "utf-8");

    // Kill the tmux session so merge can proceed
    mock.tmuxMock.activeSessions.clear();

    // Run turn_end — should auto-merge
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Check for merge notification
    const mergeCall = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "run-merge",
    );
    expect(mergeCall).toBeDefined();
    expect(mergeCall![0].content).toContain("Auto-merged: fix-bug");

    // The bugfix.txt should now be in the main branch
    const mainContent = git("show HEAD:bugfix.txt", repoDir);
    expect(mainContent).toContain("fixed");

    // Branch and worktree should be cleaned up
    const branches = git("branch --list 'pi-agent/fix-bug'", repoDir);
    expect(branches).toBe("");
  });

  it("turn_end dispatches pending tasks when deps are satisfied", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("multi-step", ctx);

    // Task B depends on A
    const planTool = mock.getTool("run_plan")!;
    await planTool.execute("call-1", {
      tasks: [
        {
          name: "task-a",
          role: "developer",
          goals: ["Do A"],
          context: "",
        },
        {
          name: "task-b",
          role: "tester",
          goals: ["Do B"],
          context: "",
          dependsOn: ["task-a"],
        },
      ],
    });

    // Task A should be launched, B should be pending
    const stateContent = await readFile(join(repoDir, RUN_STATE_FILE), "utf-8");
    const state = deserializeRunState(stateContent);
    expect(state!.sessions["task-a"]).toBeDefined();
    expect(state!.pending.map((p) => p.name)).toContain("task-b");

    // Complete task-a: commit, mark goal done
    const worktreeA = resolve(repoDir, RUN_WORKTREE_DIR, "task-a");
    execSync(
      `echo "done-a" > result-a.txt && git add . && git commit -m "complete A"`,
      { cwd: worktreeA, shell: "/bin/bash", encoding: "utf-8" },
    );

    const goalPathA = join(repoDir, RUN_DIR, "task-a.md");
    let goalA = await readFile(goalPathA, "utf-8");
    goalA = goalA.replace("- [ ] Do A", "- [x] Do A");
    await writeFile(goalPathA, goalA, "utf-8");

    // Kill tmux for task-a
    mock.tmuxMock.activeSessions.clear();

    // Run turn_end — should merge A and dispatch B
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Check that task-a was merged
    const mergeCall = mock.api.sendMessage.mock.calls.find(
      (c: any) =>
        c[0]?.customType === "run-merge" && c[0]?.content?.includes("task-a"),
    );
    expect(mergeCall).toBeDefined();

    // Check that task-b was dispatched
    const dispatchCall = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "run-dispatch",
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall![0].content).toContain("task-b");

    // task-b worktree should exist now
    const worktreeB = resolve(repoDir, RUN_WORKTREE_DIR, "task-b");
    const bStat = await stat(worktreeB);
    expect(bStat.isDirectory()).toBe(true);
  });

  it("turn_end detects completion when all tasks merged", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("single task", ctx);

    const planTool = mock.getTool("run_plan")!;
    await planTool.execute("call-1", {
      tasks: [
        {
          name: "only-task",
          role: "developer",
          goals: ["Complete it"],
          context: "",
        },
      ],
    });

    // Complete and merge
    const worktreePath = resolve(repoDir, RUN_WORKTREE_DIR, "only-task");
    execSync(
      `echo "done" > complete.txt && git add . && git commit -m "done"`,
      { cwd: worktreePath, shell: "/bin/bash", encoding: "utf-8" },
    );

    const goalPath = join(repoDir, RUN_DIR, "only-task.md");
    let goal = await readFile(goalPath, "utf-8");
    goal = goal.replace("- [ ] Complete it", "- [x] Complete it");
    await writeFile(goalPath, goal, "utf-8");

    mock.tmuxMock.activeSessions.clear();

    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Should get both merge and completion messages
    const completeCall = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "run-complete",
    );
    expect(completeCall).toBeDefined();
    expect(completeCall![0].content).toContain("Run Complete");
    expect(completeCall![0].content).toContain("only-task");

    // State should show inactive
    const stateContent = await readFile(join(repoDir, RUN_STATE_FILE), "utf-8");
    const finalState = deserializeRunState(stateContent);
    expect(finalState!.active).toBe(false);
  });

  it("/run:stop kills sessions and persists state", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("test stop", ctx);

    await mock.getTool("run_plan")!.execute("call-1", {
      tasks: [
        {
          name: "running-task",
          role: "developer",
          goals: ["Keep going"],
          context: "",
        },
      ],
    });

    // Verify tmux session was created
    expect(mock.tmuxMock.activeSessions.size).toBeGreaterThan(0);

    // Stop
    mock.api.sendMessage.mockClear();
    await mock.getCommand("run:stop")!.handler("", ctx);

    // Tmux sessions should be killed
    expect(mock.tmuxMock.activeSessions.size).toBe(0);

    // State should be persisted
    const stateContent = await readFile(join(repoDir, RUN_STATE_FILE), "utf-8");
    const state = deserializeRunState(stateContent);
    expect(state!.active).toBe(false);

    // Message should confirm
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "run-stopped",
        content: expect.stringContaining("running-task"),
      }),
      expect.anything(),
    );
  });

  it("/run:cleanup removes all worktrees, branches, and state", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("test cleanup", ctx);

    await mock.getTool("run_plan")!.execute("call-1", {
      tasks: [
        {
          name: "cleanup-task",
          role: "developer",
          goals: ["Something"],
          context: "",
        },
      ],
    });

    // Verify artifacts exist
    const runDir = join(repoDir, RUN_DIR);
    let files = await readdir(runDir);
    expect(files.length).toBeGreaterThan(0);

    // Cleanup
    await mock.getCommand("run:cleanup")!.handler("", ctx);

    // .run/ directory should be gone
    let runExists = true;
    try {
      await stat(runDir);
    } catch {
      runExists = false;
    }
    expect(runExists).toBe(false);

    // Branches should be gone
    const branches = git("branch --list 'pi-agent/*'", repoDir);
    expect(branches).toBe("");

    // Cleanup message should be sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "run-cleanup",
        content: expect.stringContaining("Cleanup complete"),
      }),
      expect.anything(),
    );
  });

  it("run_update_goal tool modifies goals", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("test goals", ctx);

    await mock.getTool("run_plan")!.execute("call-1", {
      tasks: [
        {
          name: "goal-task",
          role: "developer",
          goals: ["Original goal"],
          context: "",
        },
      ],
    });

    const updateTool = mock.getTool("run_update_goal")!;

    // Add a goal
    let result = await updateTool.execute("call-2", {
      worker: "goal-task",
      action: "add",
      goal: "New goal added",
    });
    expect(result.content[0].text).toContain("Added");

    // Verify the goal file was updated
    const goalContent = await readFile(
      join(repoDir, RUN_DIR, "goal-task.md"),
      "utf-8",
    );
    expect(goalContent).toContain("- [ ] New goal added");

    // Complete a goal
    result = await updateTool.execute("call-3", {
      worker: "goal-task",
      action: "complete",
      goal: "Original goal",
    });
    expect(result.content[0].text).toContain("Completed");

    // Verify completion
    const updated = await readFile(
      join(repoDir, RUN_DIR, "goal-task.md"),
      "utf-8",
    );
    expect(updated).toContain("- [x] Original goal");
  });

  it("run_status tool returns progress summary", async () => {
    const mock = createMockExtensionAPI(repoDir);
    initExtension(mock.api as any);

    const ctx = createMockContext(repoDir);
    await mock.emit("session_start", {}, ctx);
    await mock.getCommand("run")!.handler("test status", ctx);

    await mock.getTool("run_plan")!.execute("call-1", {
      tasks: [
        {
          name: "status-task",
          role: "tester",
          goals: ["Write tests", "Run tests"],
          context: "",
        },
      ],
    });

    const statusTool = mock.getTool("run_status")!;
    const result = await statusTool.execute("call-2", {});
    const text = result.content[0].text;

    expect(text).toContain("Run Status");
    expect(text).toContain("status-task");
    expect(text).toContain("Tester");
    expect(text).toContain("Write tests");
    expect(text).toContain("Run tests");
  });

  it("session_start restores persisted state", async () => {
    // First session: create and persist state
    const mock1 = createMockExtensionAPI(repoDir);
    initExtension(mock1.api as any);

    const ctx1 = createMockContext(repoDir);
    await mock1.emit("session_start", {}, ctx1);
    await mock1.getCommand("run")!.handler("persistence test", ctx1);

    await mock1.getTool("run_plan")!.execute("call-1", {
      tasks: [
        {
          name: "persist-task",
          role: "developer",
          goals: ["Be persistent"],
          context: "",
        },
      ],
    });

    // Persist via shutdown
    await mock1.emit("session_shutdown", {}, ctx1);

    // Second session: restore
    const mock2 = createMockExtensionAPI(repoDir);
    initExtension(mock2.api as any);

    const ctx2 = createMockContext(repoDir);
    await mock2.emit("session_start", {}, ctx2);

    // Status should show the restored state
    const statusTool = mock2.getTool("run_status")!;
    const result = await statusTool.execute("call-2", {});
    const text = result.content[0].text;

    expect(text).toContain("persist-task");
    expect(text).toContain("Be persistent");
  });
});
