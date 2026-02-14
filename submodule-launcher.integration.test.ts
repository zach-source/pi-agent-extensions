/**
 * Integration tests for submodule-launcher against a real git repo.
 *
 * These tests create temporary git repos with submodules and exercise
 * the extension end-to-end, including actual git operations.
 * Also tests standalone worktree support (no submodules required).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_DIR,
  MANAGER_STATUS_FILE,
  type SubmoduleConfig,
  type LaunchState,
  type ManagerStatusFile,
} from "./submodule-launcher.js";
import initExtension from "./submodule-launcher.js";

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
    exec: vi
      .fn()
      .mockImplementation(async (cmd: string, args: string[], opts?: any) => {
        const cwd = opts?.cwd || ".";
        try {
          const stdout = execSync(`${cmd} ${args.join(" ")}`, {
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

describe("submodule-launcher integration", () => {
  let baseDir: string;
  let parentRepo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-integ-"));

    // Create bare repos for submodules
    const apiGit = join(baseDir, "sub-api.git");
    const webGit = join(baseDir, "sub-web.git");
    git(`init --bare ${apiGit}`, baseDir);
    git(`init --bare ${webGit}`, baseDir);

    // Populate them
    const apiTmp = join(baseDir, "api-tmp");
    execSync(`git clone file://${apiGit} ${apiTmp}`, {
      cwd: baseDir,
      encoding: "utf-8",
    });
    execSync(`echo "# API" > README.md && git add . && git commit -m "init"`, {
      cwd: apiTmp,
      shell: "/bin/bash",
      encoding: "utf-8",
    });
    git("push origin main", apiTmp);

    const webTmp = join(baseDir, "web-tmp");
    execSync(`git clone file://${webGit} ${webTmp}`, {
      cwd: baseDir,
      encoding: "utf-8",
    });
    execSync(`echo "# Web" > README.md && git add . && git commit -m "init"`, {
      cwd: webTmp,
      shell: "/bin/bash",
      encoding: "utf-8",
    });
    git("push origin main", webTmp);

    // Create parent repo with submodules
    parentRepo = join(baseDir, "parent");
    git(`init ${parentRepo}`, baseDir);
    git("commit --allow-empty -m init", parentRepo);
    execSync(
      `git -c protocol.file.allow=always submodule add file://${apiGit} services/api`,
      { cwd: parentRepo, encoding: "utf-8" },
    );
    execSync(
      `git -c protocol.file.allow=always submodule add file://${webGit} apps/web`,
      { cwd: parentRepo, encoding: "utf-8" },
    );
    git("commit -m 'add submodules'", parentRepo);
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("git submodule status works on test repo", () => {
    const status = git("submodule status", parentRepo);
    expect(status).toContain("services/api");
    expect(status).toContain("apps/web");
  });

  it("/harness:init discovers submodules and scaffolds .pi-agent/", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    // Verify .pi-agent/ was created with goal files
    const piDir = join(parentRepo, PI_AGENT_DIR);
    const files = await readdir(piDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    expect(mdFiles.length).toBe(2);

    // Verify content of one goal file
    const apiGoal = await readFile(join(piDir, "api.md"), "utf-8");
    const parsed = parseGoalFile(apiGoal, "api.md");
    expect(parsed.name).toBe("api");
    expect(parsed.path).toBe("services/api");
    expect(parsed.goals.length).toBeGreaterThan(0);
  });

  it("goal files can be updated via tool and re-read", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    // Update goal via tool
    const tool = mock.getTool("harness_update_goal")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      action: "add",
      goal: "Implement REST endpoints",
    });
    expect(result.content[0].text).toContain("add");

    // Read back
    const piDir = join(parentRepo, PI_AGENT_DIR);
    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("Implement REST endpoints");
  });

  it("harness_status shows combined progress", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_status")!;
    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("api");
    expect(result.content[0].text).toContain("web");
    expect(result.details.submodules).toBe(2);
    expect(result.details.totalGoals).toBeGreaterThan(0);
  });

  it("git worktree add works from parent repo", () => {
    const wtPath = join(parentRepo, WORKTREE_DIR, "integ-test");
    const branch = "pi-agent/integ-test";

    try {
      git(`worktree add ${wtPath} -b ${branch}`, parentRepo);

      // Verify worktree exists and is on correct branch
      const currentBranch = git("branch --show-current", wtPath);
      expect(currentBranch).toBe(branch);

      // Verify we can write files to it
      execSync(`echo "test" > test-file.txt`, {
        cwd: wtPath,
        shell: "/bin/bash",
      });
      const status = git("status --porcelain", wtPath);
      expect(status).toContain("test-file.txt");
    } finally {
      // Clean up
      try {
        git(`worktree remove ${wtPath} --force`, parentRepo);
        git(`branch -D ${branch}`, parentRepo);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it("/harness:stop persists inactive state", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);

    // Write active state
    const piDir = join(parentRepo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(parentRepo, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {},
        managerSpawned: true,
        managerCwd: join(parentRepo, ".pi-agent/.manager"),
        managerSpawnedAt: new Date().toISOString(),
      }),
    );

    await mock.emit("session_start", {}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: active");

    // Stop the harness
    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    // Verify state is inactive
    const stateContent = await readFile(
      join(parentRepo, LAUNCH_STATE_FILE),
      "utf-8",
    );
    const state = JSON.parse(stateContent);
    expect(state.active).toBe(false);
  });

  it("serializeGoalFile round-trips through parseGoalFile", () => {
    const config: SubmoduleConfig = {
      name: "test-service",
      path: "services/test",
      goals: [
        { text: "Write unit tests", completed: false },
        { text: "Setup CI", completed: true },
        { text: "Deploy to staging", completed: false },
      ],
      context:
        "This is a test service for integration testing.\nIt uses TypeScript.",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    const parsed = parseGoalFile(serialized, "test-service.md");

    expect(parsed.name).toBe(config.name);
    expect(parsed.path).toBe(config.path);
    expect(parsed.goals).toEqual(config.goals);
    expect(parsed.context).toBe(config.context);
  });

  it("standalone worktree: add task, launch, verify worktree created", async () => {
    // Create a plain repo WITHOUT submodules
    const standaloneRepo = join(baseDir, "standalone");
    git(`init ${standaloneRepo}`, baseDir);
    git("commit --allow-empty -m init", standaloneRepo);

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(standaloneRepo);
    await mock.emit("session_start", {}, ctx);

    // Use /harness:add to create a task
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("refactor-auth Fix login flow, Add session handling", ctx);

    // Verify goal file was created with path: .
    const goalContent = await readFile(
      join(standaloneRepo, PI_AGENT_DIR, "refactor-auth.md"),
      "utf-8",
    );
    const parsed = parseGoalFile(goalContent, "refactor-auth.md");
    expect(parsed.name).toBe("refactor-auth");
    expect(parsed.path).toBe(".");
    expect(parsed.goals).toHaveLength(2);
    expect(parsed.goals[0].text).toBe("Fix login flow");
    expect(parsed.goals[1].text).toBe("Add session handling");

    // Override pi.exec to NOT actually spawn pi sessions (just let git through)
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          // Don't actually spawn pi — just record the call
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    // Launch the harness
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Verify worktree was created
    const wtPath = join(standaloneRepo, WORKTREE_DIR, "refactor-auth");
    const branch = git("branch --show-current", wtPath);
    expect(branch).toBe("pi-agent/refactor-auth");

    // Verify the harness-started message was sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("refactor-auth"),
      }),
      { triggerTurn: false },
    );

    // Verify launch state
    const stateContent = await readFile(
      join(standaloneRepo, LAUNCH_STATE_FILE),
      "utf-8",
    );
    const state: LaunchState = JSON.parse(stateContent);
    expect(state.active).toBe(true);
    expect(state.sessions["refactor-auth"]).toBeDefined();
    expect(state.sessions["refactor-auth"].branch).toBe(
      "pi-agent/refactor-auth",
    );

    // Clean up worktree
    try {
      git(`worktree remove ${wtPath} --force`, standaloneRepo);
      git("branch -D pi-agent/refactor-auth", standaloneRepo);
    } catch {
      // ignore cleanup errors
    }
  });

  it("buildProgressSummary formats multi-submodule state", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    // Complete one goal in api
    const tool = mock.getTool("harness_update_goal")!;
    await tool.execute("call-1", {
      submodule: "api",
      action: "complete",
      goal: "Define goals for this submodule",
    });

    // Get status
    const statusTool = mock.getTool("harness_status")!;
    const result = await statusTool.execute("call-1", {});

    const text = result.content[0].text;
    expect(text).toContain("Progress Report");
    expect(text).toContain("api");
    expect(text).toContain("web");
    // api should have some complete, web should have none
    expect(text).toContain("[x]");
  });
});

// ---------------------------------------------------------------------------
// Standalone worktree integration tests (no submodules)
// ---------------------------------------------------------------------------

describe("standalone harness (no submodules)", () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-standalone-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);

    // Create an initial commit with some content
    execSync(
      `echo "# My Project" > README.md && git add . && git commit -m "init"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
    execSync(
      `mkdir -p src && echo "export const hello = 'world';" > src/index.ts && git add . && git commit -m "add src"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  beforeEach(async () => {
    // Clean up .pi-agent/ directory so each test starts with a clean slate
    try {
      // Remove worktrees first (git requires this before branch deletion)
      const wtDir = join(repo, WORKTREE_DIR);
      try {
        const entries = await readdir(wtDir);
        for (const entry of entries) {
          try {
            git(`worktree remove ${join(wtDir, entry)} --force`, repo);
          } catch {
            // ignore
          }
        }
      } catch {
        // worktree dir may not exist
      }

      // Prune stale worktrees
      try {
        git("worktree prune", repo);
      } catch {
        // ignore
      }

      // Delete any pi-agent/* branches
      try {
        const branches = git("branch --list pi-agent/*", repo);
        for (const branch of branches.split("\n")) {
          const b = branch.trim();
          if (b) {
            try {
              git(`branch -D ${b}`, repo);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }

      // Remove .pi-agent/ directory
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      // directory may not exist on first test
    }
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  /** Helper: fresh extension + context for each test that needs isolation */
  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  /** Intercept pi spawns so we don't actually launch agent sessions */
  function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
    return originalExec;
  }

  // --- /harness:add ---

  it("/harness:add creates a standalone task with path: .", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("feature-flags Add feature flag system, Add toggle UI", ctx);

    const content = await readFile(
      join(repo, PI_AGENT_DIR, "feature-flags.md"),
      "utf-8",
    );
    const parsed = parseGoalFile(content, "feature-flags.md");
    expect(parsed.name).toBe("feature-flags");
    expect(parsed.path).toBe(".");
    expect(parsed.goals).toHaveLength(2);
    expect(parsed.goals[0].text).toBe("Add feature flag system");
    expect(parsed.goals[1].text).toBe("Add toggle UI");

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "harness-add" }),
      { triggerTurn: false },
    );
  });

  // --- harness_add_task tool ---

  it("harness_add_task tool creates task with context", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "add-logging",
      goals: ["Add structured logging", "Add log rotation"],
      context: "Use pino for structured logging.",
    });

    expect(result.content[0].text).toContain("Created task");
    expect(result.details.path).toBe(".");

    const content = await readFile(
      join(repo, PI_AGENT_DIR, "add-logging.md"),
      "utf-8",
    );
    expect(content).toContain("path: .");
    expect(content).toContain("pino");
    expect(content).toContain("Add structured logging");
  });

  // --- /harness:launch with standalone tasks ---

  it("/harness:launch creates worktrees for standalone tasks", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task via the tool
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("call-1", {
      name: "launch-test",
      goals: ["Implement feature X"],
    });

    interceptPiSpawns(mock);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("", ctx);

    // Verify worktree was created on the correct branch
    const wtPath = join(repo, WORKTREE_DIR, "launch-test");
    const branch = git("branch --show-current", wtPath);
    expect(branch).toBe("pi-agent/launch-test");

    // Verify files from main are present in the worktree
    const readme = await readFile(join(wtPath, "README.md"), "utf-8");
    expect(readme).toContain("My Project");

    // Verify heartbeat.md was written into the worktree
    const heartbeat = await readFile(join(wtPath, "heartbeat.md"), "utf-8");
    expect(heartbeat).toContain("launch-test");
    expect(heartbeat).toContain("Implement feature X");

    // Verify state
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
    expect(state.sessions["launch-test"]).toBeDefined();
    expect(state.managerSpawned).toBe(true);

    // Clean up
    git(`worktree remove ${wtPath} --force`, repo);
    git("branch -D pi-agent/launch-test", repo);
  });

  // --- Multiple standalone tasks in parallel ---

  it("launches multiple standalone tasks in parallel", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "task-alpha",
      goals: ["Alpha goal 1", "Alpha goal 2"],
    });
    await tool.execute("c2", {
      name: "task-beta",
      goals: ["Beta goal 1"],
    });

    interceptPiSpawns(mock);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("", ctx);

    // Verify both worktrees exist
    const alphaPath = join(repo, WORKTREE_DIR, "task-alpha");
    const betaPath = join(repo, WORKTREE_DIR, "task-beta");

    expect(git("branch --show-current", alphaPath)).toBe("pi-agent/task-alpha");
    expect(git("branch --show-current", betaPath)).toBe("pi-agent/task-beta");

    // Verify state has both sessions
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.sessions["task-alpha"]).toBeDefined();
    expect(state.sessions["task-beta"]).toBeDefined();

    // Verify started message mentions both
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("task-alpha"),
      }),
      { triggerTurn: false },
    );

    // Verify pi was called 3 times: 2 workers + 1 manager
    const piCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "pi",
    );
    expect(piCalls).toHaveLength(3);

    // Clean up
    git(`worktree remove ${alphaPath} --force`, repo);
    git(`worktree remove ${betaPath} --force`, repo);
    git("branch -D pi-agent/task-alpha", repo);
    git("branch -D pi-agent/task-beta", repo);
  });

  // --- harness_status with standalone tasks ---

  it("harness_status shows standalone task progress", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task and complete one goal
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "status-test",
      goals: ["Goal A", "Goal B", "Goal C"],
    });

    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("c2", {
      submodule: "status-test",
      action: "complete",
      goal: "Goal A",
    });

    const statusTool = mock.getTool("harness_status")!;
    const result = await statusTool.execute("c3", {});

    expect(result.content[0].text).toContain("status-test");
    expect(result.content[0].text).toContain("1/3");
    expect(result.details.completedGoals).toBe(1);
    expect(result.details.totalGoals).toBe(3);
  });

  // --- /harness:status command with standalone tasks ---

  it("/harness:status command works with standalone tasks", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task first (beforeEach cleans up .pi-agent/)
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "cmd-status-test",
      goals: ["Goal one", "Goal two"],
    });

    const cmd = mock.getCommand("harness:status")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-status",
        content: expect.stringContaining("cmd-status-test"),
      }),
      { triggerTurn: false },
    );
  });

  // --- harness_update_goal on standalone task ---

  it("harness_update_goal adds/completes/removes goals on standalone task", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "goal-ops-test",
      goals: ["Original goal"],
    });

    const updateTool = mock.getTool("harness_update_goal")!;

    // Add a goal
    const addResult = await updateTool.execute("c2", {
      submodule: "goal-ops-test",
      action: "add",
      goal: "New goal",
    });
    expect(addResult.content[0].text).toContain("0/2");

    // Complete a goal
    const completeResult = await updateTool.execute("c3", {
      submodule: "goal-ops-test",
      action: "complete",
      goal: "Original goal",
    });
    expect(completeResult.content[0].text).toContain("1/2");

    // Remove a goal
    const removeResult = await updateTool.execute("c4", {
      submodule: "goal-ops-test",
      action: "remove",
      goal: "New goal",
    });
    expect(removeResult.content[0].text).toContain("1/1");

    // Verify file state
    const content = await readFile(
      join(repo, PI_AGENT_DIR, "goal-ops-test.md"),
      "utf-8",
    );
    expect(content).toContain("[x] Original goal");
    expect(content).not.toContain("New goal");
  });

  // --- /harness:merge with standalone worktree ---

  it("/harness:merge merges standalone worktree branch into main", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create and launch a task
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "merge-test",
      goals: ["Add a file"],
    });

    interceptPiSpawns(mock);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Simulate work in the worktree: add a file and commit
    const wtPath = join(repo, WORKTREE_DIR, "merge-test");
    execSync(
      `echo "new content" > merge-test-file.txt && git add . && git commit -m "add merge-test-file"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );

    // Verify the file exists in the worktree but not in main
    const mainFiles = git("ls-files", repo);
    expect(mainFiles).not.toContain("merge-test-file.txt");

    // Run /harness:merge
    const mergeCmd = mock.getCommand("harness:merge")!;
    await mergeCmd.handler("merge-test", ctx);

    // Verify the file is now in main
    const mergedFiles = git("ls-files", repo);
    expect(mergedFiles).toContain("merge-test-file.txt");

    // Verify the merge message was sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-merge-result",
        content: expect.stringContaining("Merged"),
      }),
      { triggerTurn: false },
    );

    // Verify worktree and branch were cleaned up
    const branches = git("branch", repo);
    expect(branches).not.toContain("pi-agent/merge-test");
  });

  // --- /harness:stop with standalone harness ---

  it("/harness:stop writes stop signal and deactivates standalone harness", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create task and launch
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "stop-test",
      goals: ["Some goal"],
    });

    interceptPiSpawns(mock);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Verify harness is active
    const stateBefore: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(stateBefore.active).toBe(true);

    // Stop the harness
    const stopCmd = mock.getCommand("harness:stop")!;
    await stopCmd.handler("", ctx);

    // Verify stop signal was written
    const signal = await readFile(join(repo, STOP_SIGNAL_FILE), "utf-8");
    expect(signal.trim()).toBeTruthy();

    // Verify state is inactive
    const stateAfter: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(stateAfter.active).toBe(false);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("stop signal"),
      "info",
    );

    // Clean up worktree
    const wtPath = join(repo, WORKTREE_DIR, "stop-test");
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/stop-test", repo);
    } catch {
      // ignore
    }
  });

  // --- /harness:recover with standalone harness ---

  it("/harness:recover respawns manager for standalone harness", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create task and launch
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "recover-test",
      goals: ["Some goal"],
    });

    interceptPiSpawns(mock);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Clear exec calls to count only the recover spawn
    mock.api.exec.mockClear();
    interceptPiSpawns(mock);

    // Recover the manager
    const recoverCmd = mock.getCommand("harness:recover")!;
    await recoverCmd.handler("", ctx);

    // Verify a new manager pi session was spawned
    const piCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "pi",
    );
    expect(piCalls).toHaveLength(1);
    expect(piCalls[0][2].cwd).toContain(".manager");

    // Verify manager heartbeat.md was recreated
    const heartbeat = await readFile(
      join(repo, MANAGER_DIR, "heartbeat.md"),
      "utf-8",
    );
    expect(heartbeat).toContain("Launch Manager");

    expect(ctx.ui.notify).toHaveBeenCalledWith("Manager respawned", "info");

    // Clean up worktree
    const wtPath = join(repo, WORKTREE_DIR, "recover-test");
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/recover-test", repo);
    } catch {
      // ignore
    }
  });

  // --- turn_end reads manager status for standalone harness ---

  it("turn_end updates status bar from manager status file", async () => {
    const { mock, ctx } = freshHarness();

    // Pre-seed active state
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {},
        managerSpawned: true,
        managerCwd: join(repo, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
      }),
    );

    // Write a manager status file as if the manager had reported
    const status: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "standalone-task": { completed: 2, total: 5, allDone: false },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(status),
      "utf-8",
    );

    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: 2/5 goals, running",
    );
  });

  // --- Full lifecycle: add → launch → update → status → merge ---

  it("full lifecycle: add, launch, work, complete goals, merge", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // 1. Add a task
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("lifecycle-test Add new API endpoint, Write tests for endpoint", ctx);

    // 2. Launch
    interceptPiSpawns(mock);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    const wtPath = join(repo, WORKTREE_DIR, "lifecycle-test");

    // 3. Simulate work: create files and commit in the worktree
    execSync(
      `echo "export function handler() { return 'ok'; }" > api-endpoint.ts && git add . && git commit -m "add api endpoint"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );
    execSync(
      `echo "test('handler', () => {})" > api-endpoint.test.ts && git add . && git commit -m "add tests"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );

    // 4. Complete goals
    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("c1", {
      submodule: "lifecycle-test",
      action: "complete",
      goal: "Add new API endpoint",
    });
    await updateTool.execute("c2", {
      submodule: "lifecycle-test",
      action: "complete",
      goal: "Write tests for endpoint",
    });

    // 5. Verify status shows all complete
    const statusTool = mock.getTool("harness_status")!;
    const statusResult = await statusTool.execute("c3", {});
    expect(statusResult.content[0].text).toContain("DONE");
    expect(statusResult.content[0].text).toContain("lifecycle-test");

    // 6. Merge
    const mergeCmd = mock.getCommand("harness:merge")!;
    await mergeCmd.handler("lifecycle-test", ctx);

    // 7. Verify files from the worktree are now in main
    const files = git("ls-files", repo);
    expect(files).toContain("api-endpoint.ts");
    expect(files).toContain("api-endpoint.test.ts");

    // 8. Verify branch was cleaned up
    const branches = git("branch", repo);
    expect(branches).not.toContain("pi-agent/lifecycle-test");

    // 9. Verify the goal file reflects completion
    const goalContent = await readFile(
      join(repo, PI_AGENT_DIR, "lifecycle-test.md"),
      "utf-8",
    );
    expect(goalContent).toContain("[x] Add new API endpoint");
    expect(goalContent).toContain("[x] Write tests for endpoint");
  });

  // --- /harness:init shows no submodules in standalone repo ---

  it("/harness:init correctly reports no submodules", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No submodules found in this repository",
      "info",
    );
  });

  // --- Session persistence and recovery ---

  it("session state persists across shutdown and restores on start", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create and launch
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "persist-test",
      goals: ["Persistence goal"],
    });

    interceptPiSpawns(mock);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Simulate shutdown
    await mock.emit("session_shutdown", {}, ctx);

    // Verify state was persisted
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
    expect(state.sessions["persist-test"]).toBeDefined();
    expect(state.managerSpawned).toBe(true);

    // Create a fresh extension instance (simulating new session)
    const fresh = freshHarness();
    await fresh.mock.emit("session_start", {}, fresh.ctx);

    // Verify it restored as active
    expect(fresh.ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: active",
    );

    // Verify it sent a restored message
    expect(fresh.mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-restored",
      }),
      { triggerTurn: false },
    );

    // Clean up worktree
    const wtPath = join(repo, WORKTREE_DIR, "persist-test");
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/persist-test", repo);
    } catch {
      // ignore
    }
  });

  // --- Skip already-complete tasks on launch ---

  it("/harness:launch skips tasks with all goals complete", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task and immediately complete its goal
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "already-done",
      goals: ["Already finished"],
    });
    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("c2", {
      submodule: "already-done",
      action: "complete",
      goal: "Already finished",
    });

    interceptPiSpawns(mock);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Should notify that all goals are already complete
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All goals are already complete!",
      "info",
    );
  });
});
