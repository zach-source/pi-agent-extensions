/**
 * Integration tests for submodule-launcher against a real git repo.
 *
 * These tests create temporary git repos with submodules and exercise
 * the extension end-to-end, including actual git operations.
 * Also tests standalone worktree support (no submodules required).
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
import { mkdtemp, readFile, readdir, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  goalFileName,
  fuzzyMatchOne,
  HARNESS_ROLES,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_DIR,
  MANAGER_STATUS_FILE,
  type SubmoduleConfig,
  type SubmoduleQuestion,
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
      role: "tester",
      goals: [
        { text: "Write unit tests", completed: false },
        { text: "Setup CI", completed: true },
        { text: "Deploy to staging", completed: false },
      ],
      questions: [],
      context:
        "This is a test service for integration testing.\nIt uses TypeScript.",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    const parsed = parseGoalFile(serialized, "test-service.md");

    expect(parsed.name).toBe(config.name);
    expect(parsed.path).toBe(config.path);
    expect(parsed.role).toBe(config.role);
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
    await addCmd.handler(
      "refactor-auth Fix login flow, Add session handling",
      ctx,
    );

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
    await cmd.handler(
      "feature-flags Add feature flag system, Add toggle UI",
      ctx,
    );

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
    const piCalls = mock.api.exec.mock.calls.filter((c: any) => c[0] === "pi");
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
    const piCalls = mock.api.exec.mock.calls.filter((c: any) => c[0] === "pi");
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

  // --- standalone worktree with role ---

  it("standalone worktree with role: creates task with architect role, launches, verifies prompt", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task with architect role via the tool
    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("c1", {
      name: "role-test",
      goals: ["Restructure auth module", "Define clean interfaces"],
      role: "architect",
    });

    // Verify goal file has role
    const goalContent = await readFile(
      join(repo, PI_AGENT_DIR, "role-test.md"),
      "utf-8",
    );
    expect(goalContent).toContain("role: architect");
    const parsed = parseGoalFile(goalContent, "role-test.md");
    expect(parsed.role).toBe("architect");

    // Override pi.exec to capture the prompt but not actually spawn
    const piPrompts: string[] = [];
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          piPrompts.push(args[1]); // -p <prompt>
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    // Launch
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Find the worker prompt (not the manager prompt)
    const workerPrompt = piPrompts.find(
      (p) => p.includes("role-test") && !p.includes("Launch Manager"),
    );
    expect(workerPrompt).toBeDefined();
    expect(workerPrompt).toContain("a software architect focused on structure");
    expect(workerPrompt).toContain('working on "role-test"');
    expect(workerPrompt).toContain("Focus on code organization");
    expect(workerPrompt).toContain("Reduce duplication");
    expect(workerPrompt).not.toContain("Write tests first (red)");

    // Verify status shows the role tag
    const statusTool = mock.getTool("harness_status")!;
    const statusResult = await statusTool.execute("c2", {});
    expect(statusResult.content[0].text).toContain("role-test [Architect]");

    // Clean up worktree
    const wtPath = join(repo, WORKTREE_DIR, "role-test");
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/role-test", repo);
    } catch {
      // ignore
    }
  });

  // --- /harness:add with --role flag ---

  it("/harness:add with --role flag creates task with correct role", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler(
      "review-security --role reviewer Audit auth module, Check for XSS",
      ctx,
    );

    const content = await readFile(
      join(repo, PI_AGENT_DIR, "review-security.md"),
      "utf-8",
    );
    expect(content).toContain("role: reviewer");
    expect(content).toContain("Audit auth module");
    expect(content).toContain("Check for XSS");

    const parsed = parseGoalFile(content, "review-security.md");
    expect(parsed.role).toBe("reviewer");
    expect(parsed.goals).toHaveLength(2);
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
    await addCmd.handler(
      "lifecycle-test Add new API endpoint, Write tests for endpoint",
      ctx,
    );

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

  // --- Question flow with real git operations ---

  it("full question lifecycle: launch worker, worker writes questions to goal file, user answers, worker sees answers", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // 1. Create a researcher task via the tool
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "auth-spike",
      goals: ["Research auth options", "Write recommendation"],
      role: "researcher",
      context: "We need SSO for enterprise customers.",
    });

    // Verify goal file created with researcher role
    const goalPath = join(repo, PI_AGENT_DIR, "auth-spike.md");
    let goalContent = await readFile(goalPath, "utf-8");
    expect(goalContent).toContain("role: researcher");
    expect(goalContent).toContain("SSO for enterprise");
    expect(goalContent).not.toContain("## Questions");

    // 2. Launch the harness (creates real worktree, intercepts pi spawn)
    const piPrompts: string[] = [];
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          piPrompts.push(args[1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Verify real worktree was created on disk
    const wtPath = join(repo, WORKTREE_DIR, "auth-spike");
    const workerBranch = git("branch --show-current", wtPath);
    expect(workerBranch).toBe("pi-agent/auth-spike");

    // Verify worker prompt includes question instructions
    const workerPrompt = piPrompts.find(
      (p) => p.includes("auth-spike") && !p.includes("Launch Manager"),
    );
    expect(workerPrompt).toBeDefined();
    expect(workerPrompt).toContain("## Asking Questions");
    expect(workerPrompt).toContain("- ? Your question here");
    expect(workerPrompt).toContain("a technical researcher");

    // 3. Simulate worker discovering it needs decisions — writes questions
    //    directly to the goal file (as a real worker would via file I/O)
    const parsed = parseGoalFile(goalContent, "auth-spike.md");
    expect(parsed.questions).toHaveLength(0);

    // Worker appends a Questions section by re-reading and editing the file
    goalContent = await readFile(goalPath, "utf-8");
    // Worker writes questions using the - ? format
    const withQuestions =
      goalContent.trimEnd() +
      "\n\n## Questions\n- ? Should we support SAML or just OIDC?\n- ? Is there a budget constraint for auth provider?\n";
    await writeFile(goalPath, withQuestions, "utf-8");

    // 4. Verify harness_status surfaces the questions from disk
    const statusTool = mock.getTool("harness_status")!;
    let statusResult = await statusTool.execute("c2", {});

    expect(statusResult.details.unansweredQuestions).toBe(2);
    expect(statusResult.details.totalQuestions).toBe(2);
    expect(statusResult.content[0].text).toContain(
      "? Should we support SAML or just OIDC?",
    );
    expect(statusResult.content[0].text).toContain(
      "? Is there a budget constraint",
    );

    // 5. Verify /harness:status command shows question alert
    mock.api.sendMessage.mockClear();
    const statusCmd = mock.getCommand("harness:status")!;
    await statusCmd.handler("", ctx);

    const statusMsg = mock.api.sendMessage.mock.calls[0][0];
    expect(statusMsg.content).toContain("2 unanswered question(s)");
    expect(statusMsg.content).toContain("harness_answer");

    // 6. Verify manager prompt includes questions and stall-exemption
    //    (simulate recover to capture the new manager prompt)
    piPrompts.length = 0;
    mock.api.exec.mockClear();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          piPrompts.push(args[1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const recoverCmd = mock.getCommand("harness:recover")!;
    await recoverCmd.handler("", ctx);

    const managerPrompt = piPrompts.find((p) => p.includes("Launch Manager"));
    expect(managerPrompt).toBeDefined();
    expect(managerPrompt).toContain("Unanswered questions (2)");
    expect(managerPrompt).toContain("SAML or just OIDC");
    expect(managerPrompt).toContain("NOT stalled");

    // 7. User answers first question via harness_answer
    const answerTool = mock.getTool("harness_answer")!;
    const ans1 = await answerTool.execute("c3", {
      submodule: "auth-spike",
      question: "Should we support SAML or just OIDC?",
      answer: "Support both SAML and OIDC via Auth0",
    });
    expect(ans1.content[0].text).toContain("Answered");
    expect(ans1.details.remaining).toBe(1);

    // 8. Verify the goal file on disk reflects the answer
    goalContent = await readFile(goalPath, "utf-8");
    expect(goalContent).toContain(
      "- ! Should we support SAML or just OIDC? → Support both SAML and OIDC via Auth0",
    );
    expect(goalContent).toContain("- ? Is there a budget constraint");

    // 9. User answers second question
    const ans2 = await answerTool.execute("c4", {
      submodule: "auth-spike",
      question: "budget constraint",
      answer: "Max $500/mo for auth provider",
    });
    expect(ans2.details.remaining).toBe(0);

    // 10. Verify all questions answered in status
    statusResult = await statusTool.execute("c5", {});
    expect(statusResult.details.unansweredQuestions).toBe(0);
    expect(statusResult.details.totalQuestions).toBe(2);

    // 11. Simulate worker doing work in the worktree based on answers
    execSync(
      `echo "# Auth Recommendation\n\nUse Auth0 with SAML+OIDC, budget max $500/mo" > auth-recommendation.md && git add . && git commit -m "add auth recommendation based on answered questions"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );

    // 12. Complete goals via the tool
    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("c6", {
      submodule: "auth-spike",
      action: "complete",
      goal: "Research auth options",
    });
    await updateTool.execute("c7", {
      submodule: "auth-spike",
      action: "complete",
      goal: "Write recommendation",
    });

    // 13. Verify status shows DONE with answered questions
    statusResult = await statusTool.execute("c8", {});
    expect(statusResult.content[0].text).toContain("DONE");
    expect(statusResult.content[0].text).toContain("2 question(s) answered");
    expect(statusResult.details.completedGoals).toBe(2);

    // 14. Merge the worktree branch back to main
    const mergeCmd = mock.getCommand("harness:merge")!;
    await mergeCmd.handler("auth-spike", ctx);

    // 15. Verify the recommendation file made it to main
    const mainFiles = git("ls-files", repo);
    expect(mainFiles).toContain("auth-recommendation.md");

    // Verify the branch was cleaned up
    const branches = git("branch", repo);
    expect(branches).not.toContain("pi-agent/auth-spike");

    // 16. Final goal file state should have everything
    goalContent = await readFile(goalPath, "utf-8");
    const finalParsed = parseGoalFile(goalContent, "auth-spike.md");
    expect(finalParsed.role).toBe("researcher");
    expect(finalParsed.goals.every((g) => g.completed)).toBe(true);
    expect(finalParsed.questions).toHaveLength(2);
    expect(finalParsed.questions.every((q) => q.answered)).toBe(true);
    expect(finalParsed.questions[0].answer).toBe(
      "Support both SAML and OIDC via Auth0",
    );
    expect(finalParsed.questions[1].answer).toBe(
      "Max $500/mo for auth provider",
    );
  });

  it("turn_end status bar includes question count when questions exist", async () => {
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

    // Write a goal file with unanswered questions
    await writeFile(
      join(repo, PI_AGENT_DIR, "task.md"),
      [
        "# task",
        "path: .",
        "",
        "## Goals",
        "- [ ] Do something",
        "",
        "## Questions",
        "- ? What approach?",
        "- ? What priority?",
        "- ! What DB? → PostgreSQL",
      ].join("\n") + "\n",
    );

    // Write a manager status file
    const status: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        task: { completed: 0, total: 1, allDone: false },
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

    // Status bar should include question count
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: 0/1 goals, running, 2?",
    );
  });

  it("heartbeat.md includes answered questions for worker reference", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create a task with pre-answered questions via goal file
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "worker-task.md"),
      [
        "# worker-task",
        "path: .",
        "",
        "## Goals",
        "- [ ] Implement feature",
        "",
        "## Questions",
        "- ! What framework? → React",
        "- ? What testing lib?",
      ].join("\n") + "\n",
    );

    interceptPiSpawns(mock);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Read the heartbeat.md written to the worktree
    const wtPath = join(repo, WORKTREE_DIR, "worker-task");
    const heartbeat = await readFile(join(wtPath, "heartbeat.md"), "utf-8");

    // Should include answered questions
    expect(heartbeat).toContain("## Answered Questions");
    expect(heartbeat).toContain("- ! What framework? → React");

    // Should NOT include unanswered questions in heartbeat
    expect(heartbeat).not.toContain("What testing lib?");

    // Clean up
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/worker-task", repo);
    } catch {
      // ignore
    }
  });

  it("worker writes questions directly to goal file, parent reads them back via tool", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create task
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "direct-write",
      goals: ["Build the thing"],
    });

    // Simulate a worker process writing questions directly to the
    // goal file (as workers do — they don't have harness_ask, they
    // use file I/O)
    const goalPath = join(repo, PI_AGENT_DIR, "direct-write.md");
    let content = await readFile(goalPath, "utf-8");
    content =
      content.trimEnd() +
      "\n\n## Questions\n- ? Should I use REST or GraphQL?\n";
    await writeFile(goalPath, content, "utf-8");

    // Parent reads the question via harness_status
    const statusTool = mock.getTool("harness_status")!;
    const result = await statusTool.execute("c2", {});
    expect(result.details.unansweredQuestions).toBe(1);
    expect(result.content[0].text).toContain("REST or GraphQL");

    // Parent answers via harness_answer
    const answerTool = mock.getTool("harness_answer")!;
    await answerTool.execute("c3", {
      submodule: "direct-write",
      question: "REST or GraphQL",
      answer: "Use GraphQL with Apollo Server",
    });

    // Verify the file on disk — the worker would re-read this
    content = await readFile(goalPath, "utf-8");
    const parsed = parseGoalFile(content, "direct-write.md");
    expect(parsed.questions[0].answered).toBe(true);
    expect(parsed.questions[0].answer).toBe("Use GraphQL with Apollo Server");
    expect(content).toContain(
      "- ! Should I use REST or GraphQL? → Use GraphQL with Apollo Server",
    );
  });

  it("harness_ask tool writes question that round-trips through real file I/O", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Create task
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "roundtrip-test",
      goals: ["Test round-trip"],
      context: "Testing question persistence.",
    });

    // Stage questions via the tool
    const askTool = mock.getTool("harness_ask")!;
    await askTool.execute("c2", {
      submodule: "roundtrip-test",
      question: "Question Alpha?",
    });
    await askTool.execute("c3", {
      submodule: "roundtrip-test",
      question: "Question Beta?",
    });

    // Read raw file and parse it fresh — full disk round-trip
    const goalPath = join(repo, PI_AGENT_DIR, "roundtrip-test.md");
    const raw = await readFile(goalPath, "utf-8");
    const parsed = parseGoalFile(raw, "roundtrip-test.md");

    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0].text).toBe("Question Alpha?");
    expect(parsed.questions[0].answered).toBe(false);
    expect(parsed.questions[1].text).toBe("Question Beta?");
    expect(parsed.questions[1].answered).toBe(false);
    expect(parsed.context).toBe("Testing question persistence.");
    expect(parsed.goals).toHaveLength(1);

    // Answer one, verify ordering preserved
    const answerTool = mock.getTool("harness_answer")!;
    await answerTool.execute("c4", {
      submodule: "roundtrip-test",
      question: "Beta",
      answer: "Yes to Beta",
    });

    const raw2 = await readFile(goalPath, "utf-8");
    const parsed2 = parseGoalFile(raw2, "roundtrip-test.md");
    expect(parsed2.questions[0]).toEqual({
      text: "Question Alpha?",
      answered: false,
    });
    expect(parsed2.questions[1]).toEqual({
      text: "Question Beta?",
      answered: true,
      answer: "Yes to Beta",
    });
  });

  // --- Worker independence: continues achievable goals while questions are pending ---

  it("worker independence: completes achievable goals while questions for other goals remain unanswered", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // ---------------------------------------------------------------
    // Phase 1 — Launch with a seed goal; worker discovers more work
    // ---------------------------------------------------------------

    // Create researcher task with initial seed goal
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "security-audit",
      goals: ["Audit auth module for vulnerabilities"],
      role: "researcher",
      context:
        "Perform a security audit of the authentication system. " +
        "Produce markdown findings for each area reviewed.",
    });

    // Verify goal file
    const goalPath = join(repo, PI_AGENT_DIR, "security-audit.md");
    let goalContent = await readFile(goalPath, "utf-8");
    expect(goalContent).toContain("role: researcher");

    // Launch harness — capture worker prompt
    const piPrompts: string[] = [];
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          piPrompts.push(args[1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    const wtPath = join(repo, WORKTREE_DIR, "security-audit");
    expect(git("branch --show-current", wtPath)).toBe(
      "pi-agent/security-audit",
    );

    // Worker prompt includes question instructions
    const workerPrompt = piPrompts.find(
      (p) => p.includes("security-audit") && !p.includes("Launch Manager"),
    );
    expect(workerPrompt).toContain("## Asking Questions");

    // Worker discovers more work → adds 3 goals via harness_update_goal
    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("d1", {
      submodule: "security-audit",
      action: "add",
      goal: "Review input validation",
    });
    await updateTool.execute("d2", {
      submodule: "security-audit",
      action: "add",
      goal: "Assess session management",
    });
    await updateTool.execute("d3", {
      submodule: "security-audit",
      action: "add",
      goal: "Write findings report",
    });

    // Now we have 4 goals total, 0 complete
    let statusTool = mock.getTool("harness_status")!;
    let status = await statusTool.execute("s1", {});
    expect(status.details.totalGoals).toBe(4);
    expect(status.details.completedGoals).toBe(0);

    // ---------------------------------------------------------------
    // Phase 2 — Worker produces while questions are pending
    // ---------------------------------------------------------------

    // Worker completes seed goal: commits auth-audit.md in worktree
    execSync(
      `echo "# Auth Audit\\n\\nFound SQL injection in login handler." > auth-audit.md && git add . && git commit -m "audit auth module"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );
    await updateTool.execute("d4", {
      submodule: "security-audit",
      action: "complete",
      goal: "Audit auth module for vulnerabilities",
    });

    // Worker completes "Review input validation": commits input-validation.md
    execSync(
      `echo "# Input Validation Review\\n\\nXSS vectors in search params." > input-validation.md && git add . && git commit -m "review input validation"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );
    await updateTool.execute("d5", {
      submodule: "security-audit",
      action: "complete",
      goal: "Review input validation",
    });

    // Worker hits decision point for "Assess session management" — writes a question
    goalContent = await readFile(goalPath, "utf-8");
    const withQuestions =
      goalContent.trimEnd() +
      "\n\n## Questions\n" +
      "- ? Should session management audit include OAuth token lifecycle?\n" +
      "- ? Should findings report follow OWASP format or internal template?\n";
    await writeFile(goalPath, withQuestions, "utf-8");

    // KEY ASSERTION: 2/4 goals complete AND 2 unanswered questions
    status = await statusTool.execute("s2", {});
    expect(status.details.completedGoals).toBe(2);
    expect(status.details.totalGoals).toBe(4);
    expect(status.details.unansweredQuestions).toBe(2);

    // KEY ASSERTION: Progress summary shows both [x] completed goals AND ? questions
    const progressText = status.content[0].text;
    expect(progressText).toContain("[x] Audit auth module for vulnerabilities");
    expect(progressText).toContain("[x] Review input validation");
    expect(progressText).toContain(
      "? Should session management audit include OAuth token lifecycle?",
    );
    expect(progressText).toContain(
      "? Should findings report follow OWASP format or internal template?",
    );

    // KEY ASSERTION: Git commits exist in worktree BEFORE questions are answered
    const worktreeLog = git("log --oneline", wtPath);
    expect(worktreeLog).toContain("audit auth module");
    expect(worktreeLog).toContain("review input validation");

    // KEY ASSERTION: Manager prompt says "Unanswered questions" and "NOT stalled"
    piPrompts.length = 0;
    mock.api.exec.mockClear();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") {
          piPrompts.push(args[1]);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const recoverCmd = mock.getCommand("harness:recover")!;
    await recoverCmd.handler("", ctx);

    const managerPrompt = piPrompts.find((p) => p.includes("Launch Manager"));
    expect(managerPrompt).toBeDefined();
    expect(managerPrompt).toContain("Unanswered questions (2)");
    expect(managerPrompt).toContain("OAuth token lifecycle");
    expect(managerPrompt).toContain("NOT stalled");

    // KEY ASSERTION: turn_end status bar shows question count suffix
    // Pre-seed manager status for turn_end
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "security-audit": { completed: 2, total: 4, allDone: false },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
      "utf-8",
    );

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: 2/4 goals, running, 2?",
    );

    // ---------------------------------------------------------------
    // Phase 3 — User answers first question, worker resumes
    // ---------------------------------------------------------------

    const answerTool = mock.getTool("harness_answer")!;
    const ans1 = await answerTool.execute("a1", {
      submodule: "security-audit",
      question: "OAuth token lifecycle",
      answer: "Yes, include OAuth token lifecycle and refresh token handling",
    });
    expect(ans1.content[0].text).toContain("Answered");
    expect(ans1.details.remaining).toBe(1);

    // Verify goal file reflects answered question (- ! format)
    goalContent = await readFile(goalPath, "utf-8");
    expect(goalContent).toContain(
      "- ! Should session management audit include OAuth token lifecycle? → Yes, include OAuth token lifecycle and refresh token handling",
    );
    // Second question still unanswered
    expect(goalContent).toContain(
      "- ? Should findings report follow OWASP format or internal template?",
    );

    // Status now shows 1 unanswered
    status = await statusTool.execute("s3", {});
    expect(status.details.unansweredQuestions).toBe(1);

    // Worker reads answer, completes "Assess session management": commits session-mgmt.md
    execSync(
      `echo "# Session Management Assessment\\n\\nOAuth token lifecycle: refresh tokens expire after 24h.\\nIncluded per user direction." > session-mgmt.md && git add . && git commit -m "assess session management"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );
    await updateTool.execute("d6", {
      submodule: "security-audit",
      action: "complete",
      goal: "Assess session management",
    });

    // 3/4 done
    status = await statusTool.execute("s4", {});
    expect(status.details.completedGoals).toBe(3);
    expect(status.details.totalGoals).toBe(4);

    // ---------------------------------------------------------------
    // Phase 4 — User answers remaining question, worker finishes
    // ---------------------------------------------------------------

    const ans2 = await answerTool.execute("a2", {
      submodule: "security-audit",
      question: "OWASP format",
      answer: "Use OWASP format with severity ratings",
    });
    expect(ans2.details.remaining).toBe(0);

    // 0 unanswered
    status = await statusTool.execute("s5", {});
    expect(status.details.unansweredQuestions).toBe(0);

    // Worker completes "Write findings report": commits findings.md
    execSync(
      `echo "# Security Audit Findings\\n\\n## Critical\\n- SQL injection in login\\n\\n## High\\n- XSS in search params\\n\\nFormat: OWASP with severity ratings per user direction." > findings.md && git add . && git commit -m "write findings report"`,
      { cwd: wtPath, shell: "/bin/bash", encoding: "utf-8" },
    );
    await updateTool.execute("d7", {
      submodule: "security-audit",
      action: "complete",
      goal: "Write findings report",
    });

    // Status shows DONE + "2 question(s) answered"
    status = await statusTool.execute("s6", {});
    expect(status.content[0].text).toContain("DONE");
    expect(status.content[0].text).toContain("2 question(s) answered");
    expect(status.details.completedGoals).toBe(4);

    // Merge worktree branch to main
    const mergeCmd = mock.getCommand("harness:merge")!;
    await mergeCmd.handler("security-audit", ctx);

    // All 4 files exist in main repo
    const mainFiles = git("ls-files", repo);
    expect(mainFiles).toContain("auth-audit.md");
    expect(mainFiles).toContain("input-validation.md");
    expect(mainFiles).toContain("session-mgmt.md");
    expect(mainFiles).toContain("findings.md");

    // Branch cleaned up
    const branches = git("branch", repo);
    expect(branches).not.toContain("pi-agent/security-audit");

    // Final goal file state: 4/4 complete, 2/2 answered, role=researcher
    goalContent = await readFile(goalPath, "utf-8");
    const finalParsed = parseGoalFile(goalContent, "security-audit.md");
    expect(finalParsed.role).toBe("researcher");
    expect(finalParsed.goals).toHaveLength(4);
    expect(finalParsed.goals.every((g) => g.completed)).toBe(true);
    expect(finalParsed.questions).toHaveLength(2);
    expect(finalParsed.questions.every((q) => q.answered)).toBe(true);
    expect(finalParsed.questions[0].answer).toBe(
      "Yes, include OAuth token lifecycle and refresh token handling",
    );
    expect(finalParsed.questions[1].answer).toBe(
      "Use OWASP format with severity ratings",
    );
  });
});
