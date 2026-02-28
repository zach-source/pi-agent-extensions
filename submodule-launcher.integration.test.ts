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

vi.mock("@mariozechner/pi-tui", () => ({
  Text: class {
    constructor(
      public text: string,
      public x: number,
      public y: number,
    ) {}
  },
}));

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
  sendMailboxMessage,
  readMailbox,
  deleteMessage,
  readQueue,
  writeQueue,
  readRegistry,
  mailboxPath,
  HARNESS_ROLES,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_DIR,
  MANAGER_STATUS_FILE,
  MAILBOX_DIR,
  QUEUE_FILE,
  REGISTRY_FILE,
  SUMMARY_FILE,
  type SubmoduleConfig,
  type SubmoduleQuestion,
  type LaunchState,
  type ManagerStatusFile,
  type MailboxMessage,
  type WorkQueue,
  type WorkerState,
  buildBmadWorkflowDag,
  buildPlanFromAnalysis,
  BMAD_ROLE_MAP,
  BMAD_PREFIX,
  AUTO_MODE_FILE,
  SCOUT_ANALYSIS_FILE,
  SCOUT_REPORT_FILE,
  type ScoutAnalysis,
  type AutoModeState,
  HARNESS_LOG_FILE,
  HARNESS_CONFIG_FILE,
  type HarnessLogEntry,
  type SessionBackend,
  type ClaudeBackendConfig,
  USAGE_TRACKING_FILE,
  type UsageTrackingStore,
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

  it("/harness:init scaffolds .pi-agent/ with mailbox directories", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    // Verify .pi-agent/ and mailbox dirs were created
    const piDir = join(parentRepo, PI_AGENT_DIR);
    const files = await readdir(piDir);
    expect(files).toContain(".mailboxes");

    const mailboxes = await readdir(join(piDir, ".mailboxes"));
    expect(mailboxes).toContain("parent");
    expect(mailboxes).toContain("manager");
  });

  it("goal files can be updated via tool and re-read", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Create goal file first
    const piDir = join(parentRepo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Initial goal\n",
    );

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
    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("Implement REST endpoints");
  });

  it("harness_status shows combined progress", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Create goal files first
    const piDir = join(parentRepo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Build API\n",
    );
    await writeFile(
      join(piDir, "web.md"),
      "# web\npath: apps/web\n\n## Goals\n- [ ] Build UI\n",
    );

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

  it(
    "standalone worktree: add task, launch, verify worktree created",
    { timeout: 15000 },
    async () => {
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
      await launchCmd.handler("--stagger 0", ctx);

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
    },
  );

  it("buildProgressSummary formats multi-submodule state", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Create goal files first
    const piDir = join(parentRepo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Build endpoints\n- [ ] Add auth\n",
    );
    await writeFile(
      join(piDir, "web.md"),
      "# web\npath: apps/web\n\n## Goals\n- [ ] Build UI\n",
    );

    const ctx = createMockContext(parentRepo);
    await mock.emit("session_start", {}, ctx);

    // Complete one goal in api
    const tool = mock.getTool("harness_update_goal")!;
    await tool.execute("call-1", {
      submodule: "api",
      action: "complete",
      goal: "Build endpoints",
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

  /** Intercept pi and tmux spawns so we don't actually launch agent sessions */
  function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
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
    await cmd.handler("--stagger 0", ctx);

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
    await cmd.handler("--stagger 0", ctx);

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

    // Verify tmux new-session was called 3 times: 2 workers + 1 manager
    const tmuxNewCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );
    expect(tmuxNewCalls).toHaveLength(3);

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
    await launchCmd.handler("--stagger 0", ctx);

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
    await launchCmd.handler("--stagger 0", ctx);

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

    // writeRunSummary sends a summary message
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-summary",
      }),
      expect.anything(),
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
    await launchCmd.handler("--stagger 0", ctx);

    // Clear exec calls to count only the recover spawn
    mock.api.exec.mockClear();
    interceptPiSpawns(mock);

    // Recover the manager
    const recoverCmd = mock.getCommand("harness:recover")!;
    await recoverCmd.handler("", ctx);

    // Verify a new manager tmux session was spawned
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0][1]).toContain("harness-manager");

    // Verify manager prompt file was created
    const promptFile = await readFile(
      join(repo, MANAGER_DIR, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(promptFile).toContain(".manager-instructions.md");
    expect(promptFile).toContain("Current Submodules");

    // Verify static instructions file was created
    const instructionsFile = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(instructionsFile).toContain("Launch Manager");

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

    // Override exec to intercept tmux/pi spawns
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    // Launch
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Read the worker prompt from the .pi-agent-prompt.md file
    const wtPath2 = join(repo, WORKTREE_DIR, "role-test");
    const workerPrompt = await readFile(
      join(wtPath2, ".pi-agent-prompt.md"),
      "utf-8",
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
    await launchCmd.handler("--stagger 0", ctx);

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

  // --- /harness:init scaffolds directory in standalone repo ---

  it("/harness:init scaffolds .pi-agent/ and suggests /harness:add", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-init",
        content: expect.stringContaining("/harness:add"),
      }),
      { triggerTurn: false },
    );

    // Verify mailbox directories exist
    const parentDir = mailboxPath(repo, "parent");
    const managerDir = mailboxPath(repo, "manager");
    const parentFiles = await readdir(parentDir);
    expect(Array.isArray(parentFiles)).toBe(true);
    const managerFiles = await readdir(managerDir);
    expect(Array.isArray(managerFiles)).toBe(true);
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
    await launchCmd.handler("--stagger 0", ctx);

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
    await launchCmd.handler("--stagger 0", ctx);

    // Should notify that all goals are already complete
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "All goals are already complete!",
      "info",
    );
  });

  // --- Question flow with real git operations ---

  it(
    "full question lifecycle: launch worker, worker writes questions to goal file, user answers, worker sees answers",
    { timeout: 30000 },
    async () => {
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

      // 2. Launch the harness (creates real worktree, intercepts tmux/pi spawn)
      const originalExec = mock.api.exec.getMockImplementation();
      mock.api.exec.mockImplementation(
        async (cmd: string, args: string[], opts?: any) => {
          if (cmd === "pi" || cmd === "tmux") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return originalExec!(cmd, args, opts);
        },
      );

      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--stagger 0", ctx);

      // Verify real worktree was created on disk
      const wtPath = join(repo, WORKTREE_DIR, "auth-spike");
      const workerBranch = git("branch --show-current", wtPath);
      expect(workerBranch).toBe("pi-agent/auth-spike");

      // Verify worker prompt includes question instructions
      const workerPrompt = await readFile(
        join(wtPath, ".pi-agent-prompt.md"),
        "utf-8",
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
      mock.api.exec.mockClear();
      mock.api.exec.mockImplementation(
        async (cmd: string, args: string[], opts?: any) => {
          if (cmd === "pi" || cmd === "tmux") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return originalExec!(cmd, args, opts);
        },
      );

      const recoverCmd = mock.getCommand("harness:recover")!;
      await recoverCmd.handler("", ctx);

      const managerPrompt = await readFile(
        join(repo, MANAGER_DIR, ".pi-agent-prompt.md"),
        "utf-8",
      );
      expect(managerPrompt).toBeDefined();
      expect(managerPrompt).toContain("Unanswered questions (2)");
      expect(managerPrompt).toContain("SAML or just OIDC");

      // "NOT stalled" instruction is now in the static instructions file
      const instructionsPath = join(
        repo,
        PI_AGENT_DIR,
        ".manager-instructions.md",
      );
      const instructions = await readFile(instructionsPath, "utf-8");
      expect(instructions).toContain("NOT stalled");

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
    },
  );

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
    await launchCmd.handler("--stagger 0", ctx);

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

    // Launch harness — intercept tmux/pi spawns
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const wtPath = join(repo, WORKTREE_DIR, "security-audit");
    expect(git("branch --show-current", wtPath)).toBe(
      "pi-agent/security-audit",
    );

    // Worker prompt includes question instructions
    const workerPrompt = await readFile(
      join(wtPath, ".pi-agent-prompt.md"),
      "utf-8",
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
    mock.api.exec.mockClear();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );

    const recoverCmd = mock.getCommand("harness:recover")!;
    await recoverCmd.handler("", ctx);

    const managerPrompt = await readFile(
      join(repo, MANAGER_DIR, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(managerPrompt).toBeDefined();
    expect(managerPrompt).toContain("Unanswered questions (2)");
    expect(managerPrompt).toContain("OAuth token lifecycle");

    // "NOT stalled" instruction is now in the static instructions file
    const instructionsPath2 = join(
      repo,
      PI_AGENT_DIR,
      ".manager-instructions.md",
    );
    const instructions2 = await readFile(instructionsPath2, "utf-8");
    expect(instructions2).toContain("NOT stalled");

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
      "harness: 2/4 goals, running, 1a/0s/0d, 2?",
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

// ---------------------------------------------------------------------------
// Mailbox + Queue + Registry integration tests
// ---------------------------------------------------------------------------

describe("mailbox system integration", { timeout: 15000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-mailbox-integ-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);
    execSync(
      `echo "# Project" > README.md && git add . && git commit -m "init"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  beforeEach(async () => {
    // Clean up .pi-agent/ between tests
    try {
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
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
      // Clean up branches
      try {
        const branches = git("branch", repo)
          .split("\n")
          .map((b) => b.trim().replace("* ", ""))
          .filter((b) => b.startsWith("pi-agent/"));
        for (const branch of branches) {
          try {
            git(`branch -D ${branch}`, repo);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it(
    "mailbox flow: launch → worker sends question → parent reads inbox",
    { timeout: 30000 },
    async () => {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);

      // Create a task
      const piDir = join(repo, PI_AGENT_DIR);
      await mkdir(piDir, { recursive: true });
      await writeFile(
        join(piDir, "api-worker.md"),
        "# api-worker\npath: .\n\n## Goals\n- [ ] Build API\n",
      );

      // Override pi.exec to skip pi spawns
      const originalExec = mock.api.exec.getMockImplementation();
      mock.api.exec.mockImplementation(
        async (cmd: string, args: string[], opts?: any) => {
          if (cmd === "pi") return { stdout: "", stderr: "", exitCode: 0 };
          return originalExec!(cmd, args, opts);
        },
      );

      const ctx = createMockContext(repo);
      await mock.emit("session_start", {}, ctx);

      // Launch the harness
      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--stagger 0", ctx);

      // Verify mailbox directories were created
      const parentMailbox = mailboxPath(repo, "parent");
      const managerMailbox = mailboxPath(repo, "manager");
      const workerMailbox = mailboxPath(repo, "api-worker");

      await readdir(parentMailbox); // Should not throw
      await readdir(managerMailbox);
      await readdir(workerMailbox);

      // Simulate worker sending a question to parent mailbox
      await sendMailboxMessage(repo, "parent", "api-worker", "question", {
        question: "Which database should I use?",
      });

      // Parent reads inbox via tool
      const inboxTool = mock.getTool("harness_inbox")!;
      const inboxResult = await inboxTool.execute("call-1", {});

      expect(inboxResult.content[0].text).toContain("api-worker");
      expect(inboxResult.content[0].text).toContain("question");
      expect(inboxResult.details.count).toBe(1);

      // Messages should be deleted after reading
      const remaining = await readMailbox(repo, "parent");
      expect(remaining).toHaveLength(0);

      // Parent sends answer back to worker
      const sendTool = mock.getTool("harness_send")!;
      await sendTool.execute("call-2", {
        to: "api-worker",
        type: "answer",
        payload: {
          question: "Which database should I use?",
          answer: "PostgreSQL",
        },
      });

      // Verify answer arrived in worker's mailbox
      const workerMessages = await readMailbox(repo, "api-worker");
      expect(workerMessages).toHaveLength(1);
      expect(workerMessages[0].message.type).toBe("answer");
      expect(workerMessages[0].message.payload.answer).toBe("PostgreSQL");

      // Cleanup worktree
      try {
        git(
          `worktree remove ${join(repo, WORKTREE_DIR, "api-worker")} --force`,
          repo,
        );
        git("branch -D pi-agent/api-worker", repo);
      } catch {
        // ignore
      }
    },
  );

  it("queue dispatch: /harness:queue → manager gets directive → queue updated", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    // Queue work via command
    const queueCmd = mock.getCommand("harness:queue")!;
    await queueCmd.handler(
      "--role tester --priority 3 add-auth-tests Write login test, Write signup test",
      ctx,
    );

    // Verify queue file
    const queue = await readQueue(repo);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].topic).toBe("add-auth-tests");
    expect(queue.items[0].role).toBe("tester");
    expect(queue.items[0].priority).toBe(3);
    expect(queue.items[0].goals).toEqual([
      "Write login test",
      "Write signup test",
    ]);
    expect(queue.items[0].status).toBe("pending");

    // Verify queue file exists on disk
    const queueContent = await readFile(join(repo, QUEUE_FILE), "utf-8");
    const parsed = JSON.parse(queueContent);
    expect(parsed.items).toHaveLength(1);

    // Since harness was not active, no manager notification was sent
    // (the command only notifies if loopActive)
    // But let's verify the message was sent since harness was not launched
    // Actually, /harness:queue only sends to manager if loopActive
    const managerMessages = await readMailbox(repo, "manager");
    // Manager wasn't active, so no directive sent (loopActive was false)
    expect(managerMessages).toHaveLength(0);
  });

  it("queue dispatch with active harness sends directive to manager", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Set up a task and launch harness
    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "worker-1.md"),
      "# worker-1\npath: .\n\n## Goals\n- [ ] Task A\n",
    );

    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") return { stdout: "", stderr: "", exitCode: 0 };
        return originalExec!(cmd, args, opts);
      },
    );

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    // Launch to make harness active
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Drain any existing manager messages from launch
    const priorMessages = await readMailbox(repo, "manager");
    for (const m of priorMessages) {
      await deleteMessage(repo, "manager", m.filename);
    }

    // Queue work while harness is active
    const queueCmd = mock.getCommand("harness:queue")!;
    await queueCmd.handler("fix-bug Fix the login bug", ctx);

    // Manager should have received a directive
    const managerMessages = await readMailbox(repo, "manager");
    expect(managerMessages).toHaveLength(1);
    expect(managerMessages[0].message.type).toBe("directive");
    expect(managerMessages[0].message.payload.text).toContain("fix-bug");

    // Cleanup
    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "worker-1")} --force`,
        repo,
      );
      git("branch -D pi-agent/worker-1", repo);
    } catch {
      // ignore
    }
  });

  it("registry initialized on launch with worker entries", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "frontend.md"),
      "# frontend\npath: .\nrole: designer\n\n## Goals\n- [ ] Build UI\n- [ ] Add styles\n",
    );
    await writeFile(
      join(piDir, "backend.md"),
      "# backend\npath: .\nrole: developer\n\n## Goals\n- [ ] Build API\n",
    );

    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") return { stdout: "", stderr: "", exitCode: 0 };
        return originalExec!(cmd, args, opts);
      },
    );

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Verify registry was created
    const registry = await readRegistry(repo);
    expect(registry).not.toBeNull();
    expect(Object.keys(registry!.workers)).toHaveLength(2);
    expect(registry!.workers["frontend"].role).toBe("designer");
    expect(registry!.workers["frontend"].goalsTotal).toBe(2);
    expect(registry!.workers["frontend"].goalsCompleted).toBe(0);
    expect(registry!.workers["frontend"].status).toBe("active");
    expect(registry!.workers["backend"].role).toBe("developer");
    expect(registry!.workers["backend"].goalsTotal).toBe(1);

    // Cleanup
    for (const name of ["frontend", "backend"]) {
      try {
        git(`worktree remove ${join(repo, WORKTREE_DIR, name)} --force`, repo);
        git(`branch -D pi-agent/${name}`, repo);
      } catch {
        // ignore
      }
    }
  });

  it("/harness:add creates worker mailbox when harness is active", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Set up and launch harness
    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "existing.md"),
      "# existing\npath: .\n\n## Goals\n- [ ] Work\n",
    );

    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") return { stdout: "", stderr: "", exitCode: 0 };
        return originalExec!(cmd, args, opts);
      },
    );

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Drain manager messages
    const priorMessages = await readMailbox(repo, "manager");
    for (const m of priorMessages) {
      await deleteMessage(repo, "manager", m.filename);
    }

    // Add a new worker while harness is active
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("--role tester new-worker Write tests", ctx);

    // Verify worker mailbox was created
    const workerMailbox = mailboxPath(repo, "new-worker");
    const files = await readdir(workerMailbox);
    expect(Array.isArray(files)).toBe(true);

    // Verify manager was notified about new worker
    const managerMessages = await readMailbox(repo, "manager");
    expect(managerMessages).toHaveLength(1);
    expect(managerMessages[0].message.type).toBe("directive");
    expect(managerMessages[0].message.payload.text).toContain("new-worker");
    expect(managerMessages[0].message.payload.worker).toBe("new-worker");

    // Cleanup
    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "existing")} --force`,
        repo,
      );
      git("branch -D pi-agent/existing", repo);
    } catch {
      // ignore
    }
  });

  it("full mailbox roundtrip: question → answer → verify file lifecycle", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    // 1. Worker sends question to parent
    const questionId = await sendMailboxMessage(
      repo,
      "parent",
      "my-worker",
      "question",
      { question: "Redis or Memcached?" },
    );

    // 2. Verify message file exists
    const parentDir = mailboxPath(repo, "parent");
    const files = await readdir(parentDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);

    // 3. Read via tool
    const inboxTool = mock.getTool("harness_inbox")!;
    const inboxResult = await inboxTool.execute("call-1", {});
    expect(inboxResult.details.count).toBe(1);

    // 4. Files should be deleted after tool read
    const afterRead = await readdir(parentDir);
    expect(afterRead.length).toBe(0);

    // 5. Parent sends answer to worker
    const sendTool = mock.getTool("harness_send")!;
    await sendTool.execute("call-2", {
      to: "my-worker",
      type: "answer",
      payload: { question: "Redis or Memcached?", answer: "Redis" },
    });

    // 6. Verify answer in worker mailbox
    const workerMessages = await readMailbox(repo, "my-worker");
    expect(workerMessages).toHaveLength(1);

    // 7. Read the raw file to verify JSON structure
    const workerDir = mailboxPath(repo, "my-worker");
    const workerFiles = await readdir(workerDir);
    const rawContent = await readFile(join(workerDir, workerFiles[0]), "utf-8");
    const parsed: MailboxMessage = JSON.parse(rawContent);
    expect(parsed.from).toBe("parent");
    expect(parsed.to).toBe("my-worker");
    expect(parsed.type).toBe("answer");
    expect(parsed.payload.answer).toBe("Redis");

    // 8. Worker deletes after processing
    await deleteMessage(repo, "my-worker", workerFiles[0]);
    const finalMessages = await readMailbox(repo, "my-worker");
    expect(finalMessages).toHaveLength(0);
  });

  it("pending queue items trigger manager notification on launch", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Pre-populate queue before launching
    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeQueue(repo, {
      items: [
        {
          id: "pre-1",
          topic: "pre-queued-work",
          description: "Work queued before launch",
          priority: 5,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Create a task to launch
    await writeFile(
      join(piDir, "main-worker.md"),
      "# main-worker\npath: .\n\n## Goals\n- [ ] Do stuff\n",
    );

    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi") return { stdout: "", stderr: "", exitCode: 0 };
        return originalExec!(cmd, args, opts);
      },
    );

    const ctx = createMockContext(repo);
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Manager should have received a directive about pending queue items
    const managerMessages = await readMailbox(repo, "manager");
    const pendingNotification = managerMessages.find(
      (m) =>
        m.message.type === "directive" &&
        typeof m.message.payload.text === "string" &&
        m.message.payload.text.includes("pending queue item"),
    );
    expect(pendingNotification).toBeDefined();

    // Cleanup
    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "main-worker")} --force`,
        repo,
      );
      git("branch -D pi-agent/main-worker", repo);
    } catch {
      // ignore
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup and summary integration tests
// ---------------------------------------------------------------------------

describe("harness cleanup and summary integration", () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-cleanup-integ-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);
    execSync(
      `echo "# Project" > README.md && git add . && git commit -m "init"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up any leftover state from previous tests
    try {
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      // ignore
    }
    // Clean up worktrees
    try {
      const list = git("worktree list --porcelain", repo);
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ") && line.includes(".pi-agent")) {
          const wtPath = line.replace("worktree ", "");
          try {
            git(`worktree remove ${wtPath} --force`, repo);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // ignore
    }
    // Clean up branches
    try {
      const branches = git("branch", repo);
      for (const br of branches.split("\n")) {
        const name = br.replace("*", "").trim();
        if (name.startsWith("pi-agent/")) {
          try {
            git(`branch -D ${name}`, repo);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // ignore
    }
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
    return originalExec;
  }

  it("/harness:cleanup removes worktrees, branches, and state files", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create a task and launch
    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "cleanup-test.md"),
      "# cleanup-test\npath: .\n\n## Goals\n- [ ] Goal 1\n",
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Verify worktree exists
    const worktrees = git("worktree list", repo);
    expect(worktrees).toContain("cleanup-test");

    // Run cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Verify worktree was removed
    const worktreesAfter = git("worktree list", repo);
    expect(worktreesAfter).not.toContain("cleanup-test");

    // Verify state files removed
    await expect(readFile(join(repo, QUEUE_FILE), "utf-8")).rejects.toThrow();
    await expect(
      readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    ).rejects.toThrow();

    // Verify summary message sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-cleanup",
      }),
      expect.anything(),
    );
  });

  it("/harness:stop writes .summary.json with correct data", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "summary-worker.md"),
      "# summary-worker\npath: .\n\n## Goals\n- [x] Done\n- [ ] Pending\n",
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const stopCmd = mock.getCommand("harness:stop")!;
    await stopCmd.handler("", ctx);

    // Read summary file
    const summaryPath = join(repo, ".pi-agent/.summary.json");
    const summaryRaw = await readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw);

    expect(summary.stopReason).toBe("user_stop");
    expect(summary.workers).toHaveProperty("summary-worker");
    expect(summary.workers["summary-worker"].goalsTotal).toBe(2);
    expect(summary.workers["summary-worker"].goalsCompleted).toBe(1);
    expect(summary.duration).toBeTruthy();

    // Cleanup
    try {
      const cleanupCmd = mock.getCommand("harness:cleanup")!;
      await cleanupCmd.handler("--force", ctx);
    } catch {
      // Force cleanup of worktree
      try {
        git(
          `worktree remove ${join(repo, WORKTREE_DIR, "summary-worker")} --force`,
          repo,
        );
        git("branch -D pi-agent/summary-worker", repo);
      } catch {
        // ignore
      }
    }
  });

  it("/harness:launch --max-workers limits spawned workers", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const piDir = join(repo, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Create 3 tasks
    for (const name of ["mw-alpha", "mw-beta", "mw-gamma"]) {
      await writeFile(
        join(piDir, `${name}.md`),
        `# ${name}\npath: .\n\n## Goals\n- [ ] Goal 1\n- [ ] Goal 2\n`,
      );
    }

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--max-workers 1 --stagger 0", ctx);

    // Only 1 worktree should exist (plus the main one)
    const worktrees = git("worktree list", repo)
      .split("\n")
      .filter((l) => l.includes("pi-agent/mw-"));
    expect(worktrees.length).toBe(1);

    // Queue should have 2 items
    const queue = await readQueue(repo);
    expect(queue.items.filter((i) => i.status === "pending").length).toBe(2);

    // Report should mention queued tasks
    const startedMsg = mock.api.sendMessage.mock.calls.find(
      (call: any[]) => call[0]?.customType === "harness-started",
    );
    expect(startedMsg).toBeDefined();
    expect(startedMsg![0].content).toContain("Queued (--max-workers 1)");

    // Cleanup
    try {
      const cleanupCmd = mock.getCommand("harness:cleanup")!;
      await cleanupCmd.handler("--force", ctx);
    } catch {
      // Force cleanup
      for (const name of ["mw-alpha", "mw-beta", "mw-gamma"]) {
        try {
          git(
            `worktree remove ${join(repo, WORKTREE_DIR, name)} --force`,
            repo,
          );
          git(`branch -D pi-agent/${name}`, repo);
        } catch {
          // ignore
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// E2E tmux verification with real tmux sessions
// ---------------------------------------------------------------------------

describe("e2e tmux verification (real tmux sessions)", () => {
  const E2E_SERVER = "pi-harness-e2e";
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-e2e-tmux-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);
    execSync(
      `echo "# Project" > README.md && git add . && git commit -m "init"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  afterAll(async () => {
    // Kill e2e tmux server
    try {
      execSync(`tmux -L ${E2E_SERVER} kill-server`, { encoding: "utf-8" });
    } catch {
      // ignore
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up state
    try {
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      const list = git("worktree list --porcelain", repo);
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ") && line.includes(".pi-agent")) {
          const wtPath = line.replace("worktree ", "");
          try {
            git(`worktree remove ${wtPath} --force`, repo);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const branches = git("branch", repo);
      for (const br of branches.split("\n")) {
        const name = br.replace("*", "").trim();
        if (name.startsWith("pi-agent/")) {
          try {
            git(`branch -D ${name}`, repo);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    // Kill any leftover e2e tmux sessions
    try {
      execSync(`tmux -L ${E2E_SERVER} kill-server`, { encoding: "utf-8" });
    } catch {
      /* ignore */
    }
  });

  function createE2EMockAPI() {
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

          // For tmux commands: redirect to e2e server with proper quoting
          if (cmd === "tmux") {
            const adjustedArgs = args.map((a: string) =>
              a === "pi-harness" ? E2E_SERVER : a,
            );
            const quotedArgs = adjustedArgs.map((a: string) =>
              /[;\s"'$`\\(){}]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a,
            );
            try {
              const stdout = execSync(`tmux ${quotedArgs.join(" ")}`, {
                cwd,
                encoding: "utf-8",
                timeout: 10_000,
              });
              return { stdout, stderr: "", exitCode: 0 };
            } catch (e: any) {
              throw new Error(e.stderr?.toString() || "tmux command failed");
            }
          }

          // Intercept pi commands (don't actually spawn)
          if (cmd === "pi") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }

          // Pass through git and other commands
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
    };
  }

  function freshE2E() {
    const mock = createE2EMockAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function tmuxSessions(): string[] {
    try {
      const out = execSync(
        `tmux -L ${E2E_SERVER} list-sessions -F '#{session_name}'`,
        { encoding: "utf-8" },
      );
      return out.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  function tmuxHas(name: string): boolean {
    try {
      execSync(`tmux -L ${E2E_SERVER} has-session -t '${name}'`, {
        encoding: "utf-8",
      });
      return true;
    } catch {
      return false;
    }
  }

  it("launch creates real tmux sessions for workers and manager", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "e2e-worker",
      goals: ["Test tmux spawning"],
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Verify real tmux sessions exist
    const sessions = tmuxSessions();
    expect(sessions).toContain("worker-e2e-worker");
    expect(sessions).toContain("harness-manager");
    expect(tmuxHas("worker-e2e-worker")).toBe(true);
    expect(tmuxHas("harness-manager")).toBe(true);

    // Verify state file
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.managerTmuxSession).toBe("harness-manager");
    expect(state.sessions["e2e-worker"].tmuxSession).toBe("worker-e2e-worker");

    // Verify prompt files
    const wtPath = join(repo, WORKTREE_DIR, "e2e-worker");
    const prompt = await readFile(join(wtPath, ".pi-agent-prompt.md"), "utf-8");
    expect(prompt).toContain("e2e-worker");

    const mgrPrompt = await readFile(
      join(repo, MANAGER_DIR, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(mgrPrompt).toContain(".manager-instructions.md");
    expect(mgrPrompt).toContain("Current Submodules");

    // Verify static instructions file was created
    const instructionsFile = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(instructionsFile).toContain("Launch Manager");

    // Clean up
    try {
      git(`worktree remove ${wtPath} --force`, repo);
      git("branch -D pi-agent/e2e-worker", repo);
    } catch {
      /* ignore */
    }
  });

  it("/harness:stop kills real tmux sessions", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", { name: "stop-e2e", goals: ["Test stop"] });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    expect(tmuxHas("worker-stop-e2e")).toBe(true);
    expect(tmuxHas("harness-manager")).toBe(true);

    const stopCmd = mock.getCommand("harness:stop")!;
    await stopCmd.handler("", ctx);

    expect(tmuxHas("worker-stop-e2e")).toBe(false);
    expect(tmuxHas("harness-manager")).toBe(false);

    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "stop-e2e")} --force`,
        repo,
      );
      git("branch -D pi-agent/stop-e2e", repo);
    } catch {
      /* ignore */
    }
  });

  it("/harness:cleanup kills entire real tmux server", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "cleanup-e2e",
      goals: ["Test cleanup"],
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    expect(tmuxSessions().length).toBeGreaterThanOrEqual(2);

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    expect(tmuxSessions()).toEqual([]);
  });

  it("/harness:logs captures real tmux pane output", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", { name: "logs-e2e", goals: ["Log capture"] });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await new Promise((r) => setTimeout(r, 1000));
    mock.api.sendMessage.mockClear();

    const logsCmd = mock.getCommand("harness:logs")!;
    await logsCmd.handler("manager", ctx);

    const logCall = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-logs",
    );
    expect(logCall).toBeDefined();
    expect(logCall![0].content).toContain("harness-manager");

    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "logs-e2e")} --force`,
        repo,
      );
      git("branch -D pi-agent/logs-e2e", repo);
    } catch {
      /* ignore */
    }
  });

  it("/harness:attach lists real tmux sessions", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", { name: "attach-e2e", goals: ["Attach test"] });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);
    mock.api.sendMessage.mockClear();

    const attachCmd = mock.getCommand("harness:attach")!;
    await attachCmd.handler("", ctx);

    const sessionList = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-sessions",
    );
    expect(sessionList).toBeDefined();
    expect(sessionList![0].content).toContain("worker-attach-e2e");
    expect(sessionList![0].content).toContain("harness-manager");

    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "attach-e2e")} --force`,
        repo,
      );
      git("branch -D pi-agent/attach-e2e", repo);
    } catch {
      /* ignore */
    }
  });

  it("turn_end detects externally killed tmux sessions", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "liveness-e2e",
      goals: ["Liveness test"],
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);
    expect(tmuxHas("worker-liveness-e2e")).toBe(true);

    // Externally kill the worker (simulating crash)
    execSync(`tmux -L ${E2E_SERVER} kill-session -t worker-liveness-e2e`, {
      encoding: "utf-8",
    });

    // Write manager status so turn_end proceeds
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: {
          "liveness-e2e": { completed: 0, total: 1, allDone: false },
        },
        stallCount: 0,
      }),
    );

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Worker may be auto-recovered (Feature 4) or remain dead
    const statusCall = ctx.ui.setStatus.mock.calls.find(
      (c: any[]) => c[0] === "harness",
    );
    expect(statusCall).toBeDefined();
    const statusStr = statusCall![1] as string;
    const deadOrRecovered =
      statusStr.includes("1d") || statusStr.includes("1r");
    expect(deadOrRecovered).toBe(true);

    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "liveness-e2e")} --force`,
        repo,
      );
      git("branch -D pi-agent/liveness-e2e", repo);
    } catch {
      /* ignore */
    }
  });

  it("multiple workers spawn as separate real tmux sessions", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", { name: "multi-a", goals: ["First"] });
    await addTool.execute("c2", { name: "multi-b", goals: ["Second"] });
    await addTool.execute("c3", { name: "multi-c", goals: ["Third"] });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const sessions = tmuxSessions();
    expect(sessions).toContain("worker-multi-a");
    expect(sessions).toContain("worker-multi-b");
    expect(sessions).toContain("worker-multi-c");
    expect(sessions).toContain("harness-manager");
    expect(sessions.length).toBe(4);

    for (const name of ["multi-a", "multi-b", "multi-c"]) {
      try {
        git(`worktree remove ${join(repo, WORKTREE_DIR, name)} --force`, repo);
        git(`branch -D pi-agent/${name}`, repo);
      } catch {
        /* ignore */
      }
    }
  });

  it("/harness:status shows real tmux alive/dead status", async () => {
    const { mock, ctx } = freshE2E();
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", { name: "status-e2e", goals: ["Status test"] });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);
    mock.api.sendMessage.mockClear();

    const statusCmd = mock.getCommand("harness:status")!;
    await statusCmd.handler("", ctx);

    const statusCall = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-status",
    );
    expect(statusCall).toBeDefined();
    expect(statusCall![0].content).toContain("status-e2e");
    expect(statusCall![0].content).toContain("tmux: alive");

    try {
      git(
        `worktree remove ${join(repo, WORKTREE_DIR, "status-e2e")} --force`,
        repo,
      );
      git("branch -D pi-agent/status-e2e", repo);
    } catch {
      /* ignore */
    }
  });
});

// ---------------------------------------------------------------------------
// BMAD E2E: Build → Monitor → Audit → Deploy
//
// A sophisticated end-to-end test modeling a multi-role software delivery
// pipeline. Four workers with dependency chains, questions, mailbox
// communication, merge conflict resolution, queue overflow, and dashboard.
//
// Topology:
//   build-backend (developer)  ←─┐
//   build-frontend (designer)  ←─┤── audit-security (reviewer, depends on both)
//   deploy-infra (builder)     ←──── (queued via --max-workers, no dependency)
//
// Scenario:
//   1. Init harness + add 4 tasks with roles & depends_on
//   2. Launch with --max-workers 3 (deploy-infra queued)
//   3. Build workers ask questions, parent answers
//   4. Simulate commits in worktrees
//   5. Complete build goals → audit-security unblocks
//   6. Audit worker completes, merge all workers
//   7. Dashboard shows correct state throughout
//   8. Stop → verify summary, cleanup → verify pristine
// ---------------------------------------------------------------------------

describe(
  "BMAD e2e: Build → Monitor → Audit → Deploy pipeline",
  { timeout: 60000 },
  () => {
    let baseDir: string;
    let repo: string;

    beforeAll(async () => {
      baseDir = await mkdtemp(join(tmpdir(), "harness-bmad-"));
      repo = join(baseDir, "bmad-project");
      git(`init ${repo}`, baseDir);
      // Seed the repo with realistic project structure
      execSync(
        [
          "mkdir -p src/api src/web infra",
          'echo "# BMAD Project" > README.md',
          'echo "export const version = \\"1.0\\";" > src/api/index.ts',
          'echo "export const App = () => \\"hello\\";" > src/web/app.tsx',
          'echo "provider: aws" > infra/main.tf',
          "git add .",
          'git commit -m "initial commit: project scaffold"',
        ].join(" && "),
        { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
      );
    });

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      // Clean up all harness state between tests
      try {
        const wtDir = join(repo, WORKTREE_DIR);
        try {
          const entries = await readdir(wtDir);
          for (const entry of entries) {
            try {
              git(`worktree remove ${join(wtDir, entry)} --force`, repo);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* worktree dir may not exist */
        }
        try {
          git("worktree prune", repo);
        } catch {
          /* ignore */
        }
        try {
          const branches = git("branch --list pi-agent/*", repo);
          for (const branch of branches.split("\n")) {
            const b = branch.trim();
            if (b) {
              try {
                git(`branch -D ${b}`, repo);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
        await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
      } catch {
        /* first test — nothing to clean */
      }
    });

    function freshBMAD() {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);
      const ctx = createMockContext(repo);
      return { mock, ctx };
    }

    function interceptPiSpawns(
      mock: ReturnType<typeof createMockExtensionAPI>,
    ) {
      const originalExec = mock.api.exec.getMockImplementation();
      mock.api.exec.mockImplementation(
        async (cmd: string, args: string[], opts?: any) => {
          if (cmd === "pi" || cmd === "tmux") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return originalExec!(cmd, args, opts);
        },
      );
      return originalExec;
    }

    it("full pipeline: init → add(4 roles) → launch(maxWorkers) → questions → work → depends_on unblock → merge → queue dispatch → dashboard → stop → cleanup", async () => {
      const { mock, ctx } = freshBMAD();
      await mock.emit("session_start", {}, ctx);

      // =====================================================================
      // Phase 1: Initialize and create tasks via /harness:init + /harness:add
      // =====================================================================

      const initCmd = mock.getCommand("harness:init")!;
      await initCmd.handler("", ctx);

      // Verify scaffolding
      const piDir = join(repo, PI_AGENT_DIR);
      const dirs = await readdir(piDir);
      expect(dirs).toContain(".mailboxes");

      // Add tasks via harness_add_task tool
      const addTool = mock.getTool("harness_add_task")!;

      // 1. build-backend: developer role
      await addTool.execute("c1", {
        name: "build-backend",
        goals: [
          "Implement REST endpoints",
          "Add database migrations",
          "Write unit tests",
        ],
        role: "developer",
        context:
          "Backend API using Express + TypeORM. Must support PostgreSQL.",
      });

      // 2. build-frontend: designer role
      await addTool.execute("c2", {
        name: "build-frontend",
        goals: ["Create login page", "Build dashboard components"],
        role: "designer",
        context: "React + Tailwind CSS. Must be accessible (WCAG 2.1 AA).",
      });

      // 3. audit-security: reviewer role with depends_on (write manually)
      const auditGoalFile = join(piDir, "audit-security.md");
      await writeFile(
        auditGoalFile,
        [
          "# audit-security",
          "path: .",
          "role: reviewer",
          "depends_on: build-backend, build-frontend",
          "",
          "## Context",
          "Review the backend and frontend code for OWASP Top 10 vulnerabilities.",
          "",
          "## Goals",
          "- [ ] Audit authentication flow",
          "- [ ] Check for XSS in frontend",
          "- [ ] Write security report",
        ].join("\n") + "\n",
      );

      // 4. deploy-infra: builder role (will be queued due to --max-workers)
      await addTool.execute("c4", {
        name: "deploy-infra",
        goals: ["Write Terraform modules", "Set up CI/CD pipeline"],
        role: "builder",
        context: "AWS infrastructure with Terraform. Use module composition.",
      });

      // Verify all 4 goal files exist
      const goalFiles = (await readdir(piDir)).filter(
        (f) => f.endsWith(".md") && !f.startsWith("."),
      );
      expect(goalFiles.sort()).toEqual([
        "audit-security.md",
        "build-backend.md",
        "build-frontend.md",
        "deploy-infra.md",
      ]);

      // Verify audit-security has depends_on parsed correctly
      const auditContent = await readFile(auditGoalFile, "utf-8");
      const auditParsed = parseGoalFile(auditContent, "audit-security.md");
      expect(auditParsed.dependsOn).toEqual([
        "build-backend",
        "build-frontend",
      ]);
      expect(auditParsed.role).toBe("reviewer");

      // =====================================================================
      // Phase 2: Launch with --max-workers 3 → audit-security depends_on
      //          blocks it, so build-backend, build-frontend, deploy-infra
      //          spawn. But --max-workers 3 caps at 3.
      //          Actually: depends_on means audit-security goes to waiting→queue,
      //          so only build-backend, build-frontend, deploy-infra are ready.
      //          With --max-workers 2, only 2 spawn and 1 queues.
      // =====================================================================

      interceptPiSpawns(mock);

      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--max-workers 2 --stagger 0", ctx);

      // Verify launch state
      const state: LaunchState = JSON.parse(
        await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
      );
      expect(state.active).toBe(true);

      // Exactly 2 workers should have been spawned (the two with most goals)
      const spawnedWorkers = Object.keys(state.sessions);
      expect(spawnedWorkers.length).toBe(2);

      // build-backend has 3 goals (most), build-frontend has 2 → these two spawn
      expect(spawnedWorkers).toContain("build-backend");
      expect(spawnedWorkers).toContain("build-frontend");

      // deploy-infra and audit-security should be in queue
      const queue = await readQueue(repo);
      const queuedNames = queue.items.map((i) => i.topic);
      // deploy-infra is overflow from max-workers, audit-security is waiting on deps
      expect(queuedNames).toContain("deploy-infra");
      expect(queuedNames).toContain("audit-security");

      // Verify worktrees exist
      const backendWt = join(repo, WORKTREE_DIR, "build-backend");
      const frontendWt = join(repo, WORKTREE_DIR, "build-frontend");
      expect(git("branch --show-current", backendWt)).toBe(
        "pi-agent/build-backend",
      );
      expect(git("branch --show-current", frontendWt)).toBe(
        "pi-agent/build-frontend",
      );

      // Verify heartbeat files contain role-specific content
      const backendHb = await readFile(
        join(backendWt, "heartbeat.md"),
        "utf-8",
      );
      expect(backendHb).toContain("build-backend");
      expect(backendHb).toContain("Implement REST endpoints");

      // Verify worker prompts have correct role personas
      const backendPrompt = await readFile(
        join(backendWt, ".pi-agent-prompt.md"),
        "utf-8",
      );
      expect(backendPrompt).toContain("a methodical software developer");
      expect(backendPrompt).toContain("Write tests first (red)");

      const frontendPrompt = await readFile(
        join(frontendWt, ".pi-agent-prompt.md"),
        "utf-8",
      );
      expect(frontendPrompt).toContain("a frontend developer focused on UI/UX");

      // =====================================================================
      // Phase 3: Workers ask questions, parent answers
      // =====================================================================

      // Backend worker writes questions to goal file
      const backendGoalPath = join(piDir, "build-backend.md");
      let backendGoal = await readFile(backendGoalPath, "utf-8");
      backendGoal =
        backendGoal.trimEnd() +
        "\n\n## Questions\n- ? Which ORM should I use: TypeORM or Prisma?\n- ? Should REST endpoints use versioned paths (e.g. /v1/...)?\n";
      await writeFile(backendGoalPath, backendGoal, "utf-8");

      // Verify status shows questions
      const statusTool = mock.getTool("harness_status")!;
      let statusResult = await statusTool.execute("s1", {});
      expect(statusResult.details.unansweredQuestions).toBe(2);

      // Parent answers via harness_answer
      const answerTool = mock.getTool("harness_answer")!;
      await answerTool.execute("a1", {
        submodule: "build-backend",
        question: "ORM",
        answer: "Use Prisma — it has better TypeScript support",
      });
      await answerTool.execute("a2", {
        submodule: "build-backend",
        question: "versioned paths",
        answer: "Yes, use /v1/ prefix for all endpoints",
      });

      // All questions answered
      statusResult = await statusTool.execute("s2", {});
      expect(statusResult.details.unansweredQuestions).toBe(0);

      // Verify answers are in the file
      backendGoal = await readFile(backendGoalPath, "utf-8");
      expect(backendGoal).toContain("→ Use Prisma");
      expect(backendGoal).toContain("→ Yes, use /v1/ prefix");

      // =====================================================================
      // Phase 4: Simulate work in worktrees
      // =====================================================================

      // Backend worker creates commits
      // Use `git add src/` to match how a real worker would commit — only their
      // actual work files, not harness-managed files. Both heartbeat.md and
      // .pi-agent-prompt.md are now excluded via the per-worktree git exclude
      // file, but using specific paths is still best practice.
      execSync(
        [
          'echo "import express from \\"express\\";" > src/api/routes.ts',
          'echo "import { PrismaClient } from \\"@prisma/client\\";" > src/api/db.ts',
          "git add src/",
          'git commit -m "feat: add REST endpoints with Prisma"',
        ].join(" && "),
        { cwd: backendWt, shell: "/bin/bash", encoding: "utf-8" },
      );
      execSync(
        [
          'echo "CREATE TABLE users (id SERIAL PRIMARY KEY);" > src/api/migration.sql',
          "git add src/",
          'git commit -m "feat: add database migration"',
        ].join(" && "),
        { cwd: backendWt, shell: "/bin/bash", encoding: "utf-8" },
      );
      execSync(
        [
          'echo "test(\\"routes\\", () => expect(1).toBe(1));" > src/api/routes.test.ts',
          "git add src/",
          'git commit -m "test: add unit tests for routes"',
        ].join(" && "),
        { cwd: backendWt, shell: "/bin/bash", encoding: "utf-8" },
      );

      // Frontend worker creates commits
      execSync(
        [
          'echo "<form aria-label=\\"login\\"><input name=\\"email\\" /></form>" > src/web/login.tsx',
          "git add src/",
          'git commit -m "feat: create accessible login page"',
        ].join(" && "),
        { cwd: frontendWt, shell: "/bin/bash", encoding: "utf-8" },
      );
      execSync(
        [
          'echo "export const Dashboard = () => <main>Dashboard</main>;" > src/web/dashboard.tsx',
          "git add src/",
          'git commit -m "feat: build dashboard components"',
        ].join(" && "),
        { cwd: frontendWt, shell: "/bin/bash", encoding: "utf-8" },
      );

      // Complete backend goals
      const updateTool = mock.getTool("harness_update_goal")!;
      await updateTool.execute("u1", {
        submodule: "build-backend",
        action: "complete",
        goal: "Implement REST endpoints",
      });
      await updateTool.execute("u2", {
        submodule: "build-backend",
        action: "complete",
        goal: "Add database migrations",
      });
      await updateTool.execute("u3", {
        submodule: "build-backend",
        action: "complete",
        goal: "Write unit tests",
      });

      // Complete frontend goals
      await updateTool.execute("u4", {
        submodule: "build-frontend",
        action: "complete",
        goal: "Create login page",
      });
      await updateTool.execute("u5", {
        submodule: "build-frontend",
        action: "complete",
        goal: "Build dashboard components",
      });

      // Verify both are DONE
      statusResult = await statusTool.execute("s3", {});
      expect(statusResult.content[0].text).toContain("build-backend");
      expect(statusResult.content[0].text).toContain("DONE");
      expect(statusResult.content[0].text).toContain("build-frontend");

      // =====================================================================
      // Phase 5: Mailbox communication — worker sends status to parent
      // =====================================================================

      await sendMailboxMessage(
        repo,
        "parent",
        "build-backend",
        "status_report",
        {
          text: "All 3 goals complete. Backend ready for security audit.",
          commits: 3,
        },
      );

      // turn_end should surface the non-question inbox message (Issue #5 fix)
      // First write manager status for turn_end
      const mgrStatus: ManagerStatusFile = {
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: {
          "build-backend": { completed: 3, total: 3, allDone: true },
          "build-frontend": { completed: 2, total: 2, allDone: true },
        },
        stallCount: 0,
      };
      await writeFile(
        join(repo, MANAGER_STATUS_FILE),
        JSON.stringify(mgrStatus),
        "utf-8",
      );

      ctx.ui.setStatus.mockClear();
      mock.api.sendMessage.mockClear();
      await mock.emit("turn_end", {}, ctx);

      // Status bar should show goal progress (deterministic counting from all goal files:
      // build-backend 3/3 + build-frontend 2/2 + audit-security 0/3 + deploy-infra 0/2 = 5/10)
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "harness",
        expect.stringContaining("5/10 goals"),
      );

      // Non-question inbox message should have been surfaced
      const inboxCalls = mock.api.sendMessage.mock.calls.filter(
        (c: any) => c[0]?.customType === "harness-inbox",
      );
      expect(inboxCalls.length).toBe(1);
      expect(inboxCalls[0][0].content).toContain("status_report");
      expect(inboxCalls[0][0].content).toContain("build-backend");

      // Message should be deleted from inbox
      const parentInbox = await readMailbox(repo, "parent");
      expect(parentInbox).toHaveLength(0);

      // =====================================================================
      // Phase 6: Merge completed workers
      // =====================================================================

      const mergeCmd = mock.getCommand("harness:merge")!;

      // Merge backend
      await mergeCmd.handler("build-backend", ctx);
      let mainFiles = git("ls-files", repo);
      expect(mainFiles).toContain("src/api/routes.ts");
      expect(mainFiles).toContain("src/api/db.ts");
      expect(mainFiles).toContain("src/api/migration.sql");
      expect(mainFiles).toContain("src/api/routes.test.ts");

      // Merge frontend
      await mergeCmd.handler("build-frontend", ctx);
      mainFiles = git("ls-files", repo);
      expect(mainFiles).toContain("src/web/login.tsx");
      expect(mainFiles).toContain("src/web/dashboard.tsx");

      // After merge, removeWorktree uses --force to clean up excluded files
      // (heartbeat.md, .pi-agent-prompt.md) that block non-force removal.

      // =====================================================================
      // Phase 7: Dashboard shows comprehensive state
      // =====================================================================

      mock.api.sendMessage.mockClear();
      const dashboardCmd = mock.getCommand("harness:dashboard")!;
      await dashboardCmd.handler("", ctx);

      const dashCall = mock.api.sendMessage.mock.calls.find(
        (c: any) => c[0]?.customType === "harness-dashboard",
      );
      expect(dashCall).toBeDefined();
      const dashContent = dashCall![0].content;
      expect(dashContent).toContain("Harness Dashboard");
      expect(dashContent).toContain("build-backend");
      expect(dashContent).toContain("build-frontend");

      // Queue section should mention queued items
      expect(dashContent).toContain("Queue");

      // =====================================================================
      // Phase 8: Queue tool dispatches deploy-infra while active
      // =====================================================================

      // Now use the queue tool to add more work
      const queueTool = mock.getTool("harness_queue")!;
      const queueResult = await queueTool.execute("q1", {
        topic: "perf-optimization",
        description: "Optimize database queries and add caching",
        priority: 5,
        goals: ["Add query optimization", "Implement Redis caching"],
        role: "developer",
      });
      expect(queueResult.content[0].text).toContain("perf-optimization");

      // Verify it was added to queue
      const updatedQueue = await readQueue(repo);
      const perfItem = updatedQueue.items.find(
        (i) => i.topic === "perf-optimization",
      );
      expect(perfItem).toBeDefined();
      expect(perfItem!.priority).toBe(5);

      // =====================================================================
      // Phase 9: Verify depends_on — audit-security checks at re-launch
      //          Since both deps are now complete, re-launching should
      //          pick up audit-security from queue.
      // =====================================================================

      // Verify the dependency was tracked — re-read goal files to confirm
      const allConfigs = await Promise.all(
        (await readdir(piDir))
          .filter((f) => f.endsWith(".md") && !f.startsWith("."))
          .map(async (f) => {
            const content = await readFile(join(piDir, f), "utf-8");
            return parseGoalFile(content, f);
          }),
      );
      const auditConfig = allConfigs.find((c) => c.name === "audit-security");
      expect(auditConfig).toBeDefined();
      expect(auditConfig!.dependsOn).toEqual([
        "build-backend",
        "build-frontend",
      ]);

      // Verify both deps are complete
      const backendConfig = allConfigs.find((c) => c.name === "build-backend");
      expect(backendConfig!.goals.every((g) => g.completed)).toBe(true);
      const frontendConfig = allConfigs.find(
        (c) => c.name === "build-frontend",
      );
      expect(frontendConfig!.goals.every((g) => g.completed)).toBe(true);

      // =====================================================================
      // Phase 10: Stop → verify run summary
      // =====================================================================

      const stopCmd = mock.getCommand("harness:stop")!;
      await stopCmd.handler("", ctx);

      // Verify stop signal
      const stopSignal = await readFile(join(repo, STOP_SIGNAL_FILE), "utf-8");
      expect(stopSignal.trim()).toBeTruthy();

      // Verify state is inactive
      const finalState: LaunchState = JSON.parse(
        await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
      );
      expect(finalState.active).toBe(false);

      // Verify summary was written
      const summary = JSON.parse(
        await readFile(join(repo, SUMMARY_FILE), "utf-8"),
      );
      expect(summary.stopReason).toBe("user_stop");
      expect(summary.duration).toBeTruthy();
      expect(summary.workers["build-backend"]).toBeDefined();
      expect(summary.workers["build-backend"].role).toBe("developer");
      expect(summary.workers["build-backend"].goalsCompleted).toBe(3);
      expect(summary.workers["build-backend"].goalsTotal).toBe(3);
      expect(summary.workers["build-frontend"]).toBeDefined();
      expect(summary.workers["build-frontend"].role).toBe("designer");
      expect(summary.workers["build-frontend"].goalsCompleted).toBe(2);

      // =====================================================================
      // Phase 11: Cleanup → verify pristine state
      // =====================================================================

      const cleanupCmd = mock.getCommand("harness:cleanup")!;
      await cleanupCmd.handler("--force", ctx);

      // Verify no worktrees remain (cleanup --force removes orphaned worktrees)
      const worktrees = git("worktree list", repo);
      expect(worktrees).not.toContain(WORKTREE_DIR);

      // Orphaned worktree cleanup now also deletes associated pi-agent/* branches.

      // State files should be cleaned
      await expect(
        readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
      ).rejects.toThrow();
      await expect(readFile(join(repo, QUEUE_FILE), "utf-8")).rejects.toThrow();

      // But the merged code should persist in main
      mainFiles = git("ls-files", repo);
      expect(mainFiles).toContain("src/api/routes.ts");
      expect(mainFiles).toContain("src/web/login.tsx");
      expect(mainFiles).toContain("README.md");

      // Verify git log shows all the merged commits
      const log = git("log --oneline", repo);
      expect(log).toContain("REST endpoints");
      expect(log).toContain("login page");
      expect(log).toContain("dashboard components");
    });

    it("merge conflict scenario: parallel workers editing same file", async () => {
      const { mock, ctx } = freshBMAD();
      await mock.emit("session_start", {}, ctx);

      // Two workers, both will edit the same file
      const addTool = mock.getTool("harness_add_task")!;
      await addTool.execute("c1", {
        name: "worker-alpha",
        goals: ["Update README header"],
      });
      await addTool.execute("c2", {
        name: "worker-beta",
        goals: ["Update README footer"],
      });

      // mergeWorktree now checks exitCode explicitly (not just try/catch),
      // so the default mock's non-throwing behavior works for conflict detection.
      interceptPiSpawns(mock);

      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--stagger 0", ctx);

      const alphaWt = join(repo, WORKTREE_DIR, "worker-alpha");
      const betaWt = join(repo, WORKTREE_DIR, "worker-beta");

      // Alpha modifies top of README
      // NOTE: Use `git add README.md` instead of `git add .` to avoid staging
      // .pi-agent-prompt.md (see BUG note in full pipeline test above).
      execSync(
        [
          'echo "# BMAD Project v2 - Updated by alpha" > README.md',
          "git add README.md",
          'git commit -m "update README header"',
        ].join(" && "),
        { cwd: alphaWt, shell: "/bin/bash", encoding: "utf-8" },
      );

      // Beta modifies the same file differently
      execSync(
        [
          'echo "# BMAD Project - Footer by beta" > README.md',
          "git add README.md",
          'git commit -m "update README footer"',
        ].join(" && "),
        { cwd: betaWt, shell: "/bin/bash", encoding: "utf-8" },
      );

      // Merge alpha first — should succeed (fast-forward)
      const mergeCmd = mock.getCommand("harness:merge")!;
      mock.api.sendMessage.mockClear();
      await mergeCmd.handler("worker-alpha", ctx);

      const mergeAlpha = mock.api.sendMessage.mock.calls.find(
        (c: any) => c[0]?.customType === "harness-merge-result",
      );
      expect(mergeAlpha).toBeDefined();
      expect(mergeAlpha![0].content).toContain("Merged");

      // Merge beta — should fail with conflict
      mock.api.sendMessage.mockClear();
      await mergeCmd.handler("worker-beta", ctx);

      const mergeBeta = mock.api.sendMessage.mock.calls.find(
        (c: any) => c[0]?.customType === "harness-merge-result",
      );
      expect(mergeBeta).toBeDefined();
      // Merge conflict detection: message should contain "conflict" (case-insensitive)
      const betaContent = mergeBeta![0].content.toLowerCase();
      expect(betaContent).toContain("conflict");

      // Force cleanup
      for (const name of ["worker-alpha", "worker-beta"]) {
        try {
          git(
            `worktree remove ${join(repo, WORKTREE_DIR, name)} --force`,
            repo,
          );
        } catch {
          /* ignore */
        }
        try {
          git(`branch -D pi-agent/${name}`, repo);
        } catch {
          /* ignore */
        }
      }
    });

    it("registry tracks worker metadata across lifecycle", async () => {
      const { mock, ctx } = freshBMAD();
      await mock.emit("session_start", {}, ctx);

      const addTool = mock.getTool("harness_add_task")!;
      await addTool.execute("c1", {
        name: "reg-dev",
        goals: ["Build feature", "Write tests"],
        role: "developer",
      });
      await addTool.execute("c2", {
        name: "reg-test",
        goals: ["Run integration tests"],
        role: "tester",
      });

      interceptPiSpawns(mock);

      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--stagger 0", ctx);

      // Verify registry was created with correct metadata
      const registry = await readRegistry(repo);
      expect(registry).not.toBeNull();
      expect(Object.keys(registry!.workers)).toHaveLength(2);

      expect(registry!.workers["reg-dev"].role).toBe("developer");
      expect(registry!.workers["reg-dev"].goalsTotal).toBe(2);
      expect(registry!.workers["reg-dev"].goalsCompleted).toBe(0);
      expect(registry!.workers["reg-dev"].status).toBe("active");

      expect(registry!.workers["reg-test"].role).toBe("tester");
      expect(registry!.workers["reg-test"].goalsTotal).toBe(1);
      expect(registry!.workers["reg-test"].status).toBe("active");

      // Cleanup
      for (const name of ["reg-dev", "reg-test"]) {
        try {
          git(
            `worktree remove ${join(repo, WORKTREE_DIR, name)} --force`,
            repo,
          );
          git(`branch -D pi-agent/${name}`, repo);
        } catch {
          /* ignore */
        }
      }
    });

    it("session persistence and recovery across simulated restart", async () => {
      const { mock, ctx } = freshBMAD();
      await mock.emit("session_start", {}, ctx);

      const addTool = mock.getTool("harness_add_task")!;
      await addTool.execute("c1", {
        name: "persist-bmad",
        goals: ["Persist across restart"],
        role: "developer",
      });

      interceptPiSpawns(mock);

      const launchCmd = mock.getCommand("harness:launch")!;
      await launchCmd.handler("--stagger 0", ctx);

      // Simulate shutdown
      await mock.emit("session_shutdown", {}, ctx);

      // Verify state was persisted
      const state: LaunchState = JSON.parse(
        await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
      );
      expect(state.active).toBe(true);
      expect(state.sessions["persist-bmad"]).toBeDefined();

      // Simulate new session (fresh extension instance)
      const fresh = freshBMAD();
      await fresh.mock.emit("session_start", {}, fresh.ctx);

      // Should restore as active
      expect(fresh.ctx.ui.setStatus).toHaveBeenCalledWith(
        "harness",
        "harness: active",
      );

      // Cleanup
      try {
        git(
          `worktree remove ${join(repo, WORKTREE_DIR, "persist-bmad")} --force`,
          repo,
        );
        git("branch -D pi-agent/persist-bmad", repo);
      } catch {
        /* ignore */
      }
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// /harness:bmad command integration
// ═══════════════════════════════════════════════════════════════════════════════

describe("/harness:bmad command integration", { timeout: 30000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-bmad-cmd-"));
    repo = join(baseDir, "bmad-test-project");
    git(`init ${repo}`, baseDir);
    execSync(
      [
        'echo "# BMAD Test Project" > README.md',
        "mkdir -p bmad docs",
        "git add .",
        'git commit -m "initial commit"',
      ].join(" && "),
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up harness state
    try {
      const wtDir = join(repo, WORKTREE_DIR);
      try {
        const entries = await readdir(wtDir);
        for (const entry of entries) {
          try {
            git(`worktree remove ${join(wtDir, entry)} --force`, repo);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* worktree dir may not exist */
      }
      try {
        git("worktree prune", repo);
      } catch {
        /* ignore */
      }
      try {
        const branches = git("branch --list pi-agent/*", repo);
        for (const branch of branches.split("\n")) {
          const b = branch.trim();
          if (b) {
            try {
              git(`branch -D ${b}`, repo);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      /* first test — nothing to clean */
    }
  });

  function freshBmadHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
    return originalExec;
  }

  it("full /harness:bmad lifecycle: config → DAG → goal files → prompts → .bmad-mode.json → launch", async () => {
    // Write BMAD config (must use bmm: section for workflow_status_file)
    const bmadConfig = [
      "version: '6.0.0'",
      "project_name: TestBmadProject",
      "project_type: web-app",
      "project_level: 2",
      "user_name: test-user",
      "output_folder: docs",
      "",
      "bmm:",
      '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      '  sprint_status_file: "docs/sprint-status.yaml"',
      "",
      "paths:",
      "  docs: docs",
      "  stories: docs/stories",
      "  tests: tests",
    ].join("\n");
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(join(repo, "bmad", "config.yaml"), bmadConfig);

    // Write workflow status (product-brief already completed)
    const workflowStatus = [
      "# BMAD Workflow Status",
      "",
      "workflow_status:",
      "  - name: product-brief",
      "    phase: 1",
      '    status: "docs/product-brief-test-2026.md"',
      '    description: "Create product brief"',
      "",
      "  - name: brainstorm",
      "    phase: 1",
      '    status: "optional"',
      '    description: "Brainstorming session"',
      "",
      "  - name: research",
      "    phase: 1",
      '    status: "optional"',
      '    description: "Market research"',
      "",
      "  - name: prd",
      "    phase: 2",
      '    status: "required"',
      '    description: "Product Requirements Document"',
      "",
      "  - name: tech-spec",
      "    phase: 2",
      '    status: "optional"',
      '    description: "Technical Specification"',
      "",
      "  - name: create-ux-design",
      "    phase: 2",
      '    status: "optional"',
      '    description: "UX design"',
      "",
      "  - name: architecture",
      "    phase: 3",
      '    status: "required"',
      '    description: "System architecture"',
      "",
      "  - name: solutioning-gate-check",
      "    phase: 3",
      '    status: "optional"',
      '    description: "Validate architecture"',
      "",
      "  - name: sprint-planning",
      "    phase: 4",
      '    status: "required"',
      '    description: "Plan sprint iterations"',
      "",
      "  - name: create-story",
      "    phase: 4",
      '    status: "required"',
      '    description: "Create user stories"',
      "",
      "  - name: dev-story",
      "    phase: 4",
      '    status: "required"',
      '    description: "Implement story"',
    ].join("\n");
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      workflowStatus,
    );
    git("add . && git commit -m 'add bmad config and status'", repo);

    const { mock, ctx } = freshBmadHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    expect(bmadCmd).toBeDefined();

    await bmadCmd.handler("--max-workers 2", ctx);

    // Verify .bmad-mode.json was created
    const bmadModeRaw = await readFile(
      join(repo, PI_AGENT_DIR, ".bmad-mode.json"),
      "utf-8",
    );
    const bmadMode = JSON.parse(bmadModeRaw);
    expect(bmadMode.enabled).toBe(true);
    expect(bmadMode.projectLevel).toBe(2);
    expect(bmadMode.projectName).toBe("TestBmadProject");
    expect(bmadMode.workflows.length).toBeGreaterThan(0);

    // product-brief was completed, so should NOT be in workflows
    const workflowNames = bmadMode.workflows.map((w: any) => w.workflowName);
    expect(workflowNames).not.toContain("product-brief");

    // prd and architecture should be present (L2)
    expect(workflowNames).toContain("prd");
    expect(workflowNames).toContain("architecture");
    expect(workflowNames).toContain("sprint-planning");
    expect(workflowNames).toContain("create-story");
    expect(workflowNames).toContain("dev-story");

    // Verify goal files were created
    const goalFiles = await readdir(join(repo, PI_AGENT_DIR));
    const bmadGoalFiles = goalFiles.filter(
      (f) => f.startsWith("bmad-") && f.endsWith(".md"),
    );
    expect(bmadGoalFiles.length).toBeGreaterThan(0);

    // Verify a specific goal file has correct depends_on
    const prdGoal = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-prd.md"),
      "utf-8",
    );
    const prdParsed = parseGoalFile(prdGoal, "bmad-prd.md");
    expect(prdParsed.name).toBe("bmad-prd");
    // prd depends_on product-brief, but product-brief is already completed,
    // so prd should have no dependencies (the completed dep is filtered out)
    expect(prdParsed.dependsOn ?? []).toEqual([]);

    // Verify prompt files were pre-generated
    const promptFiles = await readdir(join(repo, PI_AGENT_DIR, ".prompts"));
    expect(promptFiles.length).toBeGreaterThan(0);
    expect(promptFiles).toContain("bmad-prd.md");

    // Verify prompt content contains autonomous preamble
    const prdPrompt = await readFile(
      join(repo, PI_AGENT_DIR, ".prompts", "bmad-prd.md"),
      "utf-8",
    );
    expect(prdPrompt).toContain("Autonomous BMAD Worker");
    expect(prdPrompt).toContain("no interactive user");

    // Verify manager instructions contain BMAD section
    const mgrInstructions = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(mgrInstructions).toContain("BMAD Phase Management");
    expect(mgrInstructions).toContain("TestBmadProject");
    expect(mgrInstructions).toContain("Dev-story fan-out");

    // Verify launch message was sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "harness-bmad-started" }),
      { triggerTurn: false },
    );

    // Verify status was set
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: bmad active",
    );

    // Verify state was persisted
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);

    // Verify mailbox directories created
    const mailboxes = await readdir(join(repo, MAILBOX_DIR));
    expect(mailboxes).toContain("manager");
    expect(mailboxes).toContain("parent");

    // Cleanup worktrees
    try {
      const wtDir = join(repo, WORKTREE_DIR);
      const entries = await readdir(wtDir);
      for (const entry of entries) {
        try {
          git(`worktree remove ${join(wtDir, entry)} --force`, repo);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  });

  it("errors when no BMAD config exists", async () => {
    // Make sure there's no bmad config
    await rm(join(repo, "bmad"), { recursive: true, force: true });

    const { mock, ctx } = freshBmadHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No BMAD configuration"),
      "error",
    );
  });

  it("L0 project: minimal 4-workflow chain with correct dependencies and role mapping", async () => {
    // L0 = single atomic change — smallest possible BMAD run
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        'project_name: "TinyFix"',
        "project_type: library",
        "project_level: 0",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
        "",
        "paths:",
        "  docs: docs",
        "  stories: docs/stories",
        "  tests: tests",
      ].join("\n"),
    );

    // Empty status — nothing completed yet
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "workflow_status:",
        "  - name: tech-spec",
        "    phase: 2",
        '    status: "required"',
        '    description: "Tech spec"',
        "  - name: sprint-planning",
        "    phase: 4",
        '    status: "required"',
        '    description: "Sprint planning"',
        "  - name: create-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Create stories"',
        "  - name: dev-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Develop story"',
      ].join("\n"),
    );
    git("add . && git commit -m 'L0 project scaffold'", repo);

    const { mock, ctx } = freshBmadHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--max-workers 4", ctx);

    // --- Verify .bmad-mode.json ---
    const modeRaw = await readFile(
      join(repo, PI_AGENT_DIR, ".bmad-mode.json"),
      "utf-8",
    );
    const mode = JSON.parse(modeRaw);
    expect(mode.projectLevel).toBe(0);
    const wfNames = mode.workflows.map((w: any) => w.workflowName);
    // L0 = tech-spec → sprint-planning → create-story → dev-story
    expect(wfNames).toEqual([
      "tech-spec",
      "sprint-planning",
      "create-story",
      "dev-story",
    ]);

    // --- Verify dependency chain ---
    const byName = (n: string) =>
      mode.workflows.find((w: any) => w.workflowName === n);
    expect(byName("tech-spec").dependsOn).toEqual([]);
    expect(byName("sprint-planning").dependsOn).toEqual(["bmad-tech-spec"]);
    expect(byName("create-story").dependsOn).toEqual(["bmad-sprint-planning"]);
    expect(byName("dev-story").dependsOn).toEqual(["bmad-create-story"]);

    // --- Only tech-spec should be ready (no deps), rest should be queued ---
    // With max-workers 4 but only 1 has no deps, only 1 should be active
    const activeWfs = mode.workflows.filter((w: any) => w.status === "active");
    const pendingWfs = mode.workflows.filter(
      (w: any) => w.status === "pending",
    );
    expect(activeWfs.length).toBe(1);
    expect(activeWfs[0].workflowName).toBe("tech-spec");
    expect(pendingWfs.length).toBe(3);

    // --- Verify goal files ---
    const goalFiles = (await readdir(join(repo, PI_AGENT_DIR)))
      .filter((f) => f.startsWith("bmad-") && f.endsWith(".md"))
      .sort();
    expect(goalFiles).toEqual([
      "bmad-create-story.md",
      "bmad-dev-story.md",
      "bmad-sprint-planning.md",
      "bmad-tech-spec.md",
    ]);

    // --- Verify goal file content (round-trip) ---
    for (const gf of goalFiles) {
      const content = await readFile(join(repo, PI_AGENT_DIR, gf), "utf-8");
      const parsed = parseGoalFile(content, gf);
      expect(parsed.goals.length).toBeGreaterThan(0);
      expect(parsed.goals.every((g) => !g.completed)).toBe(true);
      expect(parsed.role).toBeTruthy();
    }

    // --- Verify role mapping correctness ---
    const tsGoal = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-tech-spec.md"),
      "utf-8",
    );
    const tsParsed = parseGoalFile(tsGoal, "bmad-tech-spec.md");
    // tech-spec agent is "Product Manager" → role should be "researcher"
    expect(tsParsed.role).toBe("researcher");

    const spGoal = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-sprint-planning.md"),
      "utf-8",
    );
    const spParsed = parseGoalFile(spGoal, "bmad-sprint-planning.md");
    // sprint-planning agent is "Scrum Master" → role should be "planner"
    expect(spParsed.role).toBe("planner");

    const dsGoal = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-dev-story.md"),
      "utf-8",
    );
    const dsParsed = parseGoalFile(dsGoal, "bmad-dev-story.md");
    // dev-story agent is "Developer" → role should be "developer"
    // But developer is default so the serializer omits it
    expect(dsParsed.role).toBe("developer");

    // --- Verify prompt files ---
    const promptFiles = (
      await readdir(join(repo, PI_AGENT_DIR, ".prompts"))
    ).sort();
    expect(promptFiles).toEqual([
      "bmad-create-story.md",
      "bmad-dev-story.md",
      "bmad-sprint-planning.md",
      "bmad-tech-spec.md",
    ]);

    // --- Prompt content quality checks ---
    for (const pf of promptFiles) {
      const content = await readFile(
        join(repo, PI_AGENT_DIR, ".prompts", pf),
        "utf-8",
      );
      // All prompts must have autonomous preamble
      expect(content).toContain("Autonomous BMAD Worker");
      expect(content).toContain("no interactive user");
      expect(content).toContain("Do NOT ask questions");
      // All prompts must have harness instructions
      expect(content).toContain("goal file");
      expect(content).toContain("heartbeat.md");
      expect(content).toContain("Mailbox");
    }

    // --- Verify worktree was created only for ready worker ---
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    expect(worktrees).toContain("bmad-tech-spec");
    // The others are queued, so NO worktrees for them
    expect(worktrees).not.toContain("bmad-sprint-planning");
    expect(worktrees).not.toContain("bmad-create-story");
    expect(worktrees).not.toContain("bmad-dev-story");

    // --- Verify worktree has prompt file copied in ---
    const wtPrompt = await readFile(
      join(wtDir, "bmad-tech-spec", ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(wtPrompt).toContain("Technical Specification");
    expect(wtPrompt).toContain("Autonomous BMAD Worker");

    // --- Verify worktree has heartbeat.md ---
    const wtHeartbeat = await readFile(
      join(wtDir, "bmad-tech-spec", "heartbeat.md"),
      "utf-8",
    );
    expect(wtHeartbeat).toContain("bmad-tech-spec");

    // --- Verify worker state sidecar ---
    const stateRaw = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-tech-spec.state.json"),
      "utf-8",
    );
    const state: WorkerState = JSON.parse(stateRaw);
    expect(state.name).toBe("bmad-tech-spec");
    expect(state.status).toBe("active");
    expect(state.goalsCompleted).toBe(0);
    expect(state.goalsTotal).toBe(1);
    expect(state.mergeStatus).toBe("pending");
    expect(state.dependenciesMet).toBe(true);

    // --- Verify queue contains the 3 waiting workflows ---
    const queue = await readQueue(repo);
    const pendingQueueItems = queue.items.filter((i) => i.status === "pending");
    expect(pendingQueueItems.length).toBe(3);
    const queueTopics = pendingQueueItems.map((i) => i.topic).sort();
    expect(queueTopics).toEqual([
      "bmad-create-story",
      "bmad-dev-story",
      "bmad-sprint-planning",
    ]);

    // --- Verify registry ---
    const registry = await readRegistry(repo);
    expect(registry.workers["bmad-tech-spec"]).toBeDefined();
    expect(registry.workers["bmad-tech-spec"].status).toBe("active");
    expect(registry.workers["bmad-tech-spec"].role).toBe("researcher");
    // Queued workers should NOT be in registry (not yet spawned)
    expect(registry.workers["bmad-sprint-planning"]).toBeUndefined();

    // --- Verify manager instructions ---
    const mgrInstructions = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(mgrInstructions).toContain("BMAD Phase Management");
    expect(mgrInstructions).toContain("TinyFix");
    expect(mgrInstructions).toContain("Level 0");
    expect(mgrInstructions).toContain("Dev-story fan-out");
    expect(mgrInstructions).toContain("bmad-mode.json");

    // --- Verify mailbox directories ---
    const mailboxes = (await readdir(join(repo, MAILBOX_DIR))).sort();
    expect(mailboxes).toContain("bmad-tech-spec");
    expect(mailboxes).toContain("bmad-sprint-planning");
    expect(mailboxes).toContain("bmad-create-story");
    expect(mailboxes).toContain("bmad-dev-story");
    expect(mailboxes).toContain("manager");
    expect(mailboxes).toContain("parent");

    // --- Verify manager was notified about queued items ---
    const mgrMessages = await readMailbox(repo, "manager");
    expect(mgrMessages.length).toBeGreaterThan(0);
    const directiveMsg = mgrMessages.find(
      (m) => m.message.type === "directive",
    );
    expect(directiveMsg).toBeDefined();
    expect(directiveMsg!.message.payload).toHaveProperty("text");

    // --- Verify launch state persistence ---
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.sessions["bmad-tech-spec"]).toBeDefined();
    expect(launchState.sessions["bmad-tech-spec"].spawned).toBe(true);
    expect(launchState.managerSpawned).toBe(true);

    // Cleanup
    try {
      const entries = await readdir(wtDir);
      for (const entry of entries) {
        try {
          git(`worktree remove ${join(wtDir, entry)} --force`, repo);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  });

  it("L3 project with mixed completion: verifies correct partial DAG and parallel fan-out", async () => {
    // L3 = complex integration project. Pre-complete Phase 1+2 and partially Phase 3.
    // This simulates resuming mid-project.
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        'project_name: "EnterpriseApp"',
        "project_type: web-app",
        "project_level: 3",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
        "",
        "paths:",
        "  docs: docs",
        "  stories: docs/stories",
        "  tests: tests",
      ].join("\n"),
    );

    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "workflow_status:",
        // Phase 1 - all completed
        "  - name: product-brief",
        "    phase: 1",
        '    status: "docs/product-brief-enterprise-2026.md"',
        '    description: "Product brief"',
        "  - name: brainstorm",
        "    phase: 1",
        '    status: "docs/brainstorm-enterprise-2026.md"',
        '    description: "Brainstorm"',
        "  - name: research",
        "    phase: 1",
        '    status: "docs/research-enterprise-2026.md"',
        '    description: "Research"',
        // Phase 2 - PRD completed, others still pending
        "  - name: prd",
        "    phase: 2",
        '    status: "docs/prd-enterprise-2026.md"',
        '    description: "PRD"',
        "  - name: create-ux-design",
        "    phase: 2",
        '    status: "optional"',
        '    description: "UX design"',
        // Phase 3 - architecture not completed
        "  - name: architecture",
        "    phase: 3",
        '    status: "required"',
        '    description: "Architecture"',
        "  - name: solutioning-gate-check",
        "    phase: 3",
        '    status: "optional"',
        '    description: "Gate check"',
        // Phase 4 - all pending
        "  - name: sprint-planning",
        "    phase: 4",
        '    status: "required"',
        '    description: "Sprint planning"',
        "  - name: create-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Create stories"',
        "  - name: dev-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Develop story"',
      ].join("\n"),
    );
    git("add . && git commit -m 'L3 project mid-progress'", repo);

    const { mock, ctx } = freshBmadHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--max-workers 3", ctx);

    const modeRaw = await readFile(
      join(repo, PI_AGENT_DIR, ".bmad-mode.json"),
      "utf-8",
    );
    const mode = JSON.parse(modeRaw);
    const wfNames = mode.workflows.map((w: any) => w.workflowName);

    // Completed workflows should be excluded
    expect(wfNames).not.toContain("product-brief");
    expect(wfNames).not.toContain("brainstorm");
    expect(wfNames).not.toContain("research");
    expect(wfNames).not.toContain("prd");

    // Remaining workflows should be present
    expect(wfNames).toContain("create-ux-design");
    expect(wfNames).toContain("architecture");
    expect(wfNames).toContain("solutioning-gate-check");
    expect(wfNames).toContain("sprint-planning");
    expect(wfNames).toContain("create-story");
    expect(wfNames).toContain("dev-story");

    // --- Verify dependency correctness with partial completion ---
    const byName = (n: string) =>
      mode.workflows.find((w: any) => w.workflowName === n);

    // create-ux-design depends on prd, but prd is already completed → no deps
    expect(byName("create-ux-design").dependsOn).toEqual([]);

    // architecture depends on prd (completed, filtered out) → no remaining deps
    expect(byName("architecture").dependsOn).toEqual([]);

    // solutioning-gate-check depends on architecture (still in plan)
    expect(byName("solutioning-gate-check").dependsOn).toEqual([
      "bmad-architecture",
    ]);

    // sprint-planning depends on architecture (still in plan)
    expect(byName("sprint-planning").dependsOn).toEqual(["bmad-architecture"]);

    // --- With deps resolved, both create-ux-design and architecture should be ready ---
    const activeWfs = mode.workflows.filter((w: any) => w.status === "active");
    // create-ux-design has no deps, architecture has no deps → both ready
    // With max-workers 3, we can spawn up to 3 ready workers
    expect(activeWfs.length).toBeGreaterThanOrEqual(2);
    const activeNames = activeWfs.map((w: any) => w.workflowName);
    expect(activeNames).toContain("create-ux-design");
    expect(activeNames).toContain("architecture");

    // --- Verify each active worker has a worktree ---
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    for (const name of activeNames) {
      expect(worktrees).toContain(`bmad-${name}`);
    }

    // --- Verify prompt files reference correct BMAD workflows ---
    const archPrompt = await readFile(
      join(repo, PI_AGENT_DIR, ".prompts", "bmad-architecture.md"),
      "utf-8",
    );
    expect(archPrompt).toContain("System Architect");
    expect(archPrompt).toContain("architecture");

    const uxPrompt = await readFile(
      join(repo, PI_AGENT_DIR, ".prompts", "bmad-create-ux-design.md"),
      "utf-8",
    );
    expect(uxPrompt).toContain("UX Designer");

    // --- Verify report message mentions active and queued ---
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "harness-bmad-started" }),
      { triggerTurn: false },
    );
    const reportCall = mock.api.sendMessage.mock.calls.find(
      (call: any) => call[0]?.customType === "harness-bmad-started",
    );
    expect(reportCall).toBeDefined();
    const reportContent: string = reportCall[0].content;
    expect(reportContent).toContain("EnterpriseApp");
    expect(reportContent).toContain("Level 3");

    // Cleanup
    try {
      const entries = await readdir(wtDir);
      for (const entry of entries) {
        try {
          git(`worktree remove ${join(wtDir, entry)} --force`, repo);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  });

  it("all-complete scenario: returns early without spawning anything", async () => {
    // Project where every workflow is already completed
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        'project_name: "DoneProject"',
        "project_type: api",
        "project_level: 0",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
        "",
        "paths:",
        "  docs: docs",
      ].join("\n"),
    );

    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "workflow_status:",
        "  - name: tech-spec",
        "    phase: 2",
        '    status: "docs/tech-spec-done.md"',
        '    description: "Tech spec"',
        "  - name: sprint-planning",
        "    phase: 4",
        '    status: "docs/sprint-plan-done.md"',
        '    description: "Sprint planning"',
        "  - name: create-story",
        "    phase: 4",
        '    status: "docs/stories-done.md"',
        '    description: "Create stories"',
        "  - name: dev-story",
        "    phase: 4",
        '    status: "docs/dev-story-done.md"',
        '    description: "Develop story"',
      ].join("\n"),
    );
    git("add . && git commit -m 'all-complete project'", repo);

    const { mock, ctx } = freshBmadHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("", ctx);

    // Should notify all complete and NOT create .pi-agent/ artifacts
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already complete"),
      "info",
    );
    // No .bmad-mode.json should exist
    let modeExists = true;
    try {
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8");
    } catch {
      modeExists = false;
    }
    expect(modeExists).toBe(false);
  });

  it("verifies cross-level DAG consistency: L0 ⊂ L1 ⊂ L2", async () => {
    // Run buildBmadWorkflowDag at all levels and verify subset relationships
    const { WORKFLOW_DEFS: WF_DEFS } = await import("./bmad.js");
    const dag0 = buildBmadWorkflowDag(0, [], WF_DEFS).map(
      (s) => s.workflowName,
    );
    const dag1 = buildBmadWorkflowDag(1, [], WF_DEFS).map(
      (s) => s.workflowName,
    );
    const dag2 = buildBmadWorkflowDag(2, [], WF_DEFS).map(
      (s) => s.workflowName,
    );
    const dag3 = buildBmadWorkflowDag(3, [], WF_DEFS).map(
      (s) => s.workflowName,
    );

    // L0 core workflows must appear in all higher levels
    for (const wf of dag0) {
      // L1 may use tech-spec instead of prd, so core chain should be present
      if (
        wf === "sprint-planning" ||
        wf === "create-story" ||
        wf === "dev-story"
      ) {
        expect(dag1).toContain(wf);
        expect(dag2).toContain(wf);
        expect(dag3).toContain(wf);
      }
    }

    // L2+ must have prd and architecture (L0/L1 may not)
    expect(dag2).toContain("prd");
    expect(dag2).toContain("architecture");
    expect(dag3).toContain("prd");
    expect(dag3).toContain("architecture");

    // L0 should NOT have product-brief, brainstorm, research, prd, architecture
    expect(dag0).not.toContain("product-brief");
    expect(dag0).not.toContain("brainstorm");
    expect(dag0).not.toContain("prd");
    expect(dag0).not.toContain("architecture");

    // L1 adds product-brief but not prd
    expect(dag1).toContain("product-brief");
    expect(dag1).not.toContain("prd");

    // Verify no duplicate entries at any level
    expect(new Set(dag0).size).toBe(dag0.length);
    expect(new Set(dag1).size).toBe(dag1.length);
    expect(new Set(dag2).size).toBe(dag2.length);
    expect(new Set(dag3).size).toBe(dag3.length);
  });

  it("refuses to launch when harness is already active", async () => {
    // Write BMAD config
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        "project_name: Test",
        "project_type: web-app",
        "project_level: 0",
        "user_name: test",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
        '  sprint_status_file: "docs/sprint-status.yaml"',
        "",
        "paths:",
        "  docs: docs",
        "  stories: docs/stories",
        "  tests: tests",
      ].join("\n"),
    );

    // Write workflow status
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "workflow_status:",
        "  - name: tech-spec",
        "    phase: 2",
        '    status: "required"',
        '    description: "Tech spec"',
        "",
        "  - name: sprint-planning",
        "    phase: 4",
        '    status: "required"',
        '    description: "Sprint planning"',
        "",
        "  - name: create-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Create stories"',
        "",
        "  - name: dev-story",
        "    phase: 4",
        '    status: "required"',
        '    description: "Develop story"',
      ].join("\n"),
    );
    git("add . && git commit -m 'add L0 bmad config'", repo);

    const { mock, ctx } = freshBmadHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // First launch should succeed
    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--max-workers 1", ctx);

    // Second launch should be blocked
    await bmadCmd.handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already active"),
      "warning",
    );

    // Cleanup
    try {
      const wtDir = join(repo, WORKTREE_DIR);
      const entries = await readdir(wtDir);
      for (const entry of entries) {
        try {
          git(`worktree remove ${join(wtDir, entry)} --force`, repo);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  });
});

// ---------------------------------------------------------------------------
// BMAD Harness Stress Tests & Edge Cases
// ---------------------------------------------------------------------------

describe(
  "BMAD harness: stress tests and edge cases",
  { timeout: 60000 },
  () => {
    let baseDir: string;
    let repo: string;

    beforeAll(async () => {
      baseDir = await mkdtemp(join(tmpdir(), "harness-bmad-stress-"));
      repo = join(baseDir, "stress-project");
      git(`init ${repo}`, baseDir);
      execSync(
        'echo "# Stress" > README.md && git add . && git commit -m "init"',
        { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
      );
    });

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      try {
        const wtDir = join(repo, WORKTREE_DIR);
        try {
          const entries = await readdir(wtDir);
          for (const entry of entries) {
            try {
              git(`worktree remove ${join(wtDir, entry)} --force`, repo);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* wtdir may not exist */
        }
        try {
          git("worktree prune", repo);
        } catch {
          /* ignore */
        }
        try {
          const branches = git("branch --list pi-agent/*", repo);
          for (const branch of branches.split("\n")) {
            const b = branch.trim();
            if (b) {
              try {
                git(`branch -D ${b}`, repo);
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
        await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
        await rm(join(repo, "bmad"), { recursive: true, force: true });
        await rm(join(repo, "docs"), { recursive: true, force: true });
      } catch {
        /* first test */
      }
    });

    function freshBmadHarness() {
      const mock = createMockExtensionAPI();
      initExtension(mock.api as any);
      const ctx = createMockContext(repo);
      return { mock, ctx };
    }

    function interceptPiSpawns(
      mock: ReturnType<typeof createMockExtensionAPI>,
    ) {
      const originalExec = mock.api.exec.getMockImplementation();
      mock.api.exec.mockImplementation(
        async (cmd: string, args: string[], opts?: any) => {
          if (cmd === "pi" || cmd === "tmux") {
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return originalExec!(cmd, args, opts);
        },
      );
      return originalExec;
    }

    async function writeBmadConfig(level: number, name: string) {
      await mkdir(join(repo, "bmad"), { recursive: true });
      await writeFile(
        join(repo, "bmad", "config.yaml"),
        [
          `project_name: "${name}"`,
          "project_type: web-app",
          `project_level: ${level}`,
          "",
          "bmm:",
          '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
          '  sprint_status_file: "docs/sprint-status.yaml"',
          "",
          "paths:",
          "  docs: docs",
          "  stories: docs/stories",
          "  tests: tests",
        ].join("\n"),
      );
    }

    async function writeStatusFile(
      entries: Array<{ name: string; status: string; phase: number }>,
    ) {
      await mkdir(join(repo, "docs"), { recursive: true });
      const lines = ["workflow_status:"];
      for (const e of entries) {
        lines.push(
          `  - name: ${e.name}`,
          `    phase: ${e.phase}`,
          `    status: "${e.status}"`,
          `    description: "${e.name} workflow"`,
        );
      }
      await writeFile(
        join(repo, "docs", "bmm-workflow-status.yaml"),
        lines.join("\n"),
      );
    }

    // =========================================================================
    // 1. Prompt Autonomy Sanitization — verify NO interactive phrases survive
    // =========================================================================
    it("prompt autonomy: all interactive phrases are replaced across every workflow at every level", async () => {
      // For each level, build prompts for all workflows and verify no interactive
      // phrases leaked through the M5 transformation.
      const interactivePatterns = [
        /[Ii]nterview the user/,
        /[Aa]sk the user/,
        /[Aa]sk which /,
        /[Cc]onfirm with the user/,
        /[Dd]iscuss with the user/,
        /[Pp]resent for (?:user )?review/,
        /and present for review/,
        /[Gg]ather .*?from the user/,
        /[Ss]uggest the next recommended workflow to the user/,
      ];

      for (const level of [0, 1, 2, 3]) {
        await writeBmadConfig(level, `PromptTest-L${level}`);
        await writeStatusFile([]); // Nothing completed

        const { mock, ctx } = freshBmadHarness();
        await mock.emit("session_start", {}, ctx);
        interceptPiSpawns(mock);

        const bmadCmd = mock.getCommand("harness:bmad")!;
        await bmadCmd.handler("--max-workers 1", ctx);

        // Read all generated prompt files
        const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
        let promptFiles: string[];
        try {
          promptFiles = (await readdir(promptsDir)).filter((f) =>
            f.endsWith(".md"),
          );
        } catch {
          promptFiles = [];
        }

        const violations: string[] = [];
        for (const pf of promptFiles) {
          const content = await readFile(join(promptsDir, pf), "utf-8");
          for (const pattern of interactivePatterns) {
            if (pattern.test(content)) {
              violations.push(`${pf} contains "${pattern.source}"`);
            }
          }
          // Verify autonomous preamble IS present
          expect(content).toContain("running autonomously");
          // Verify the "When Complete" section tells worker the manager handles sequencing
          expect(content).toContain(
            "harness manager handles workflow sequencing",
          );
          // Verify the "Asking Questions" section exists
          expect(content).toContain("## Asking Questions");
          // M3: Verify no duplicate "When Complete" sections — the raw BMAD
          // "### When Complete" should be stripped, leaving only our "## When Complete"
          const whenCompleteMatches =
            content.match(/#+\s+When Complete/g) || [];
          if (whenCompleteMatches.length > 1) {
            violations.push(
              `${pf} has ${whenCompleteMatches.length} "When Complete" sections`,
            );
          }
        }

        expect(violations).toEqual([]);

        // Cleanup for next level iteration
        try {
          const wtDir = join(repo, WORKTREE_DIR);
          const entries = await readdir(wtDir);
          for (const entry of entries) {
            try {
              git(`worktree remove ${join(wtDir, entry)} --force`, repo);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        try {
          git("worktree prune", repo);
        } catch {
          /* ignore */
        }
        try {
          const branches = git("branch --list pi-agent/*", repo);
          for (const b of branches
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)) {
            try {
              git(`branch -D ${b}`, repo);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
      }
    });

    // =========================================================================
    // 2. Max-workers throttling — verify only N workers spawn even with many ready
    // =========================================================================
    it("max-workers=1 throttles to exactly 1 active worker, rest queued", async () => {
      // L2 project with nothing completed → many ready Phase 1 workflows
      await writeBmadConfig(2, "ThrottleTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      // Read .bmad-mode.json — only 1 workflow should be "active"
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );
      const active = modeJson.workflows.filter(
        (w: any) => w.status === "active",
      );
      const pending = modeJson.workflows.filter(
        (w: any) => w.status === "pending",
      );

      expect(active.length).toBe(1);
      expect(pending.length).toBeGreaterThan(0);
      expect(active.length + pending.length).toBe(modeJson.workflows.length);

      // Only 1 worktree should exist
      const wtDir = join(repo, WORKTREE_DIR);
      const worktrees = await readdir(wtDir);
      expect(worktrees.length).toBe(1);

      // Queue should contain the rest
      const queue = await readQueue(repo);
      expect(queue.items.length).toBeGreaterThan(0);

      // Verify maxWorkers is written to the mode file
      expect(modeJson.maxWorkers).toBe(1);
    });

    // =========================================================================
    // 3. Stop→Restart cycle: verify BMAD prompts cleaned up and fresh launch works
    // =========================================================================
    it("stop cleans up BMAD prompts, second launch starts fresh", async () => {
      await writeBmadConfig(0, "RestartTest");
      await writeStatusFile([
        { name: "tech-spec", phase: 2, status: "required" },
        { name: "sprint-planning", phase: 4, status: "required" },
        { name: "create-story", phase: 4, status: "required" },
        { name: "dev-story", phase: 4, status: "required" },
      ]);

      // First launch
      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("", ctx);

      // Prompts should exist
      const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
      const promptsBefore = await readdir(promptsDir);
      expect(promptsBefore.length).toBeGreaterThan(0);

      // Stop the harness
      const stopCmd = mock.getCommand("harness:stop")!;
      await stopCmd.handler("", ctx);

      // Prompts directory should be cleaned up
      let promptsAfterStop: string[] = [];
      try {
        promptsAfterStop = await readdir(promptsDir);
      } catch {
        // Directory removed entirely — also acceptable
      }
      expect(promptsAfterStop.length).toBe(0);

      // Cleanup worktrees for a fresh start
      try {
        const wtDir = join(repo, WORKTREE_DIR);
        const entries = await readdir(wtDir);
        for (const entry of entries) {
          try {
            git(`worktree remove ${join(wtDir, entry)} --force`, repo);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      try {
        git("worktree prune", repo);
      } catch {
        /* ignore */
      }
      try {
        const branches = git("branch --list pi-agent/*", repo);
        for (const b of branches
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)) {
          try {
            git(`branch -D ${b}`, repo);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      // Second launch with fresh harness instance
      const h2 = freshBmadHarness();
      await h2.mock.emit("session_start", {}, h2.ctx);
      interceptPiSpawns(h2.mock);

      const bmadCmd2 = h2.mock.getCommand("harness:bmad")!;
      await bmadCmd2.handler("", h2.ctx);

      // Fresh prompts created
      const promptsAfterRelaunch = await readdir(promptsDir);
      expect(promptsAfterRelaunch.length).toBeGreaterThan(0);

      // .bmad-mode.json refreshed
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );
      expect(modeJson.enabled).toBe(true);
      expect(modeJson.workflows.some((w: any) => w.status === "active")).toBe(
        true,
      );
    });

    // =========================================================================
    // 4. Cleanup removes ALL BMAD artifacts (prompts, mode file, worktrees)
    // =========================================================================
    it("harness:cleanup removes BMAD prompts, .bmad-mode.json, and all worktrees", async () => {
      await writeBmadConfig(1, "CleanupTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 2", ctx);

      // Verify artifacts exist
      const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
      expect((await readdir(promptsDir)).length).toBeGreaterThan(0);
      const modeFile = join(repo, PI_AGENT_DIR, ".bmad-mode.json");
      const modeBefore = JSON.parse(await readFile(modeFile, "utf-8"));
      expect(modeBefore.enabled).toBe(true);

      // Stop first (cleanup requires stopped harness)
      const stopCmd = mock.getCommand("harness:stop")!;
      await stopCmd.handler("", ctx);

      // Run cleanup
      const cleanupCmd = mock.getCommand("harness:cleanup")!;
      await cleanupCmd.handler("--force", ctx);

      // Verify prompts directory gone
      let promptsGone = false;
      try {
        await readdir(promptsDir);
      } catch {
        promptsGone = true;
      }
      expect(promptsGone).toBe(true);

      // Verify .bmad-mode.json gone
      let modeGone = false;
      try {
        await readFile(modeFile, "utf-8");
      } catch {
        modeGone = true;
      }
      expect(modeGone).toBe(true);

      // Verify worktrees cleaned
      let wtGone = false;
      try {
        const entries = await readdir(join(repo, WORKTREE_DIR));
        wtGone = entries.length === 0;
      } catch {
        wtGone = true;
      }
      expect(wtGone).toBe(true);
    });

    // =========================================================================
    // 5. Malformed status file — warning emitted but launch still proceeds
    // =========================================================================
    it("malformed status file emits warning but launches all workflows as incomplete", async () => {
      await writeBmadConfig(0, "MalformedTest");
      // Write a status file with invalid YAML structure (not array format)
      await mkdir(join(repo, "docs"), { recursive: true });
      await writeFile(
        join(repo, "docs", "bmm-workflow-status.yaml"),
        "this is not valid workflow YAML\njust some garbage text\n",
      );

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("", ctx);

      // Should have emitted a warning about malformed status file
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("yielded 0 workflow entries"),
        "warning",
      );

      // But should still have launched — all 4 L0 workflows treated as incomplete
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );
      expect(modeJson.workflows.length).toBe(4);
    });

    // =========================================================================
    // 6. Role persona appears in BMAD worker prompts
    // =========================================================================
    it("each BMAD worker prompt includes its role persona", async () => {
      await writeBmadConfig(2, "RolePersonaTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
      const promptFiles = (await readdir(promptsDir)).filter((f) =>
        f.endsWith(".md"),
      );

      // Map expected roles: workflow → expected persona snippet
      const expectedPersonas: Record<string, string> = {
        "bmad-product-brief.md": "business analyst",
        "bmad-brainstorm.md": "exploration", // researcher role
        "bmad-research.md": "exploration", // researcher role
        "bmad-prd.md": "exploration", // researcher → Product Manager
        "bmad-tech-spec.md": "exploration", // researcher → Product Manager
        "bmad-create-ux-design.md": "frontend developer focused on UI/UX",
        "bmad-architecture.md": "software architect",
        "bmad-solutioning-gate-check.md": "software architect",
        "bmad-sprint-planning.md": "project planner",
        "bmad-create-story.md": "project planner",
        "bmad-dev-story.md": "methodical software developer",
      };

      for (const pf of promptFiles) {
        const content = await readFile(join(promptsDir, pf), "utf-8");
        const expected = expectedPersonas[pf];
        if (expected) {
          expect(content.toLowerCase()).toContain(expected.toLowerCase());
        }
        // All prompts must say "You are ..." — not just "You are running autonomously"
        expect(content).toMatch(/You are [a-z]/);
      }
    });

    // =========================================================================
    // 7. Dependency resolution correctness under partial completion
    // =========================================================================
    it("complex partial completion: deps correctly resolved across phases", async () => {
      // L2 project where Phase 1 done, prd done but create-ux-design not
      // NOTE: At L2, tech-spec is NOT in the plan (L2 uses prd+architecture).
      // Architecture depends on [prd, tech-spec] → at L2, tech-spec is out-of-plan so only prd matters.
      // With prd completed, architecture should be ready.
      await writeBmadConfig(2, "PartialDeps");
      await writeStatusFile([
        { name: "product-brief", phase: 1, status: "docs/product-brief.md" },
        { name: "brainstorm", phase: 1, status: "docs/brainstorm.md" },
        { name: "research", phase: 1, status: "docs/research.md" },
        { name: "prd", phase: 2, status: "docs/prd.md" },
        // create-ux-design depends on prd (completed) → should be ready
        { name: "create-ux-design", phase: 2, status: "optional" },
      ]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 10", ctx);

      // Read goal files to verify dependency chains
      const piDir = join(repo, PI_AGENT_DIR);

      // create-ux-design: no unmet deps (prd completed → filtered out)
      const uxGoal = await readFile(
        join(piDir, "bmad-create-ux-design.md"),
        "utf-8",
      );
      expect(uxGoal).not.toContain("depends_on:");

      // architecture: at L2, depends on [prd, tech-spec]. prd completed, tech-spec NOT in L2 plan.
      // Both deps are satisfied → architecture should have no unmet deps
      const archGoal = await readFile(
        join(piDir, "bmad-architecture.md"),
        "utf-8",
      );
      expect(archGoal).not.toContain("depends_on:");

      // solutioning-gate-check: depends on architecture (unmet — just unblocked, not completed)
      const gateGoal = await readFile(
        join(piDir, "bmad-solutioning-gate-check.md"),
        "utf-8",
      );
      expect(gateGoal).toContain("bmad-architecture");

      // sprint-planning: at L2, depends on [architecture, tech-spec]. tech-spec out-of-plan → only architecture
      const sprintGoal = await readFile(
        join(piDir, "bmad-sprint-planning.md"),
        "utf-8",
      );
      expect(sprintGoal).toContain("bmad-architecture");
      expect(sprintGoal).not.toContain("bmad-tech-spec"); // tech-spec is out-of-plan at L2

      // Read .bmad-mode.json — architecture + create-ux-design should be active (ready, no unmet deps)
      const modeJson = JSON.parse(
        await readFile(join(piDir, ".bmad-mode.json"), "utf-8"),
      );
      const activeNames = modeJson.workflows
        .filter((w: any) => w.status === "active")
        .map((w: any) => w.name);
      expect(activeNames).toContain("bmad-architecture");
      expect(activeNames).toContain("bmad-create-ux-design");
      // solutioning-gate-check should be pending (waiting for architecture)
      const gateWorkflow = modeJson.workflows.find(
        (w: any) => w.name === "bmad-solutioning-gate-check",
      );
      expect(gateWorkflow.status).toBe("pending");
    });

    // =========================================================================
    // 8. Manager instructions contain BMAD-specific sections with correct metadata
    // =========================================================================
    it("manager instructions include BMAD phase management with correct project metadata", async () => {
      await writeBmadConfig(3, "ManagerMetaTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 2", ctx);

      // Read manager instructions from file (written to .pi-agent/.manager-instructions.md, NOT inside MANAGER_DIR)
      const instructionsFile = join(
        repo,
        PI_AGENT_DIR,
        ".manager-instructions.md",
      );
      const instructions = await readFile(instructionsFile, "utf-8");

      // Verify BMAD phase management section
      expect(instructions).toContain("## BMAD Phase Management");
      expect(instructions).toContain("ManagerMetaTest");
      expect(instructions).toContain("Level 3");
      expect(instructions).toContain("Max concurrent workers: 2");

      // Verify dependency unblocking instructions
      expect(instructions).toContain(".bmad-mode.json");
      expect(instructions).toContain('"completed"');
      expect(instructions).toContain(
        "NOT listed in `.bmad-mode.json` at all is considered satisfied",
      );

      // Verify registry update instruction for new workers
      expect(instructions).toContain("Add the new worker to the registry");

      // Verify dev-story fan-out
      expect(instructions).toContain("Dev-story fan-out");
      expect(instructions).toContain("bmad-create-story");
      expect(instructions).toContain("docs/stories/STORY-*.md");

      // Verify staleness detection
      expect(instructions).toContain("Staleness detection");
      expect(instructions).toContain("heartbeat staleness");
    });

    // =========================================================================
    // 9. "skipped" means "intentionally not doing this" → isCompleted("skipped") → true
    //    Skipped workflows are EXCLUDED from the DAG (treated as done).
    //    Dependencies on skipped workflows are satisfied.
    // =========================================================================
    it("'skipped' status workflows are excluded from DAG and satisfy dependencies", async () => {
      await writeBmadConfig(2, "SkippedTest");
      await writeStatusFile([
        { name: "product-brief", phase: 1, status: "skipped" },
        { name: "brainstorm", phase: 1, status: "skipped" },
        { name: "research", phase: 1, status: "skipped" },
        // prd "required" → not completed
        { name: "prd", phase: 2, status: "required" },
      ]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );

      // "skipped" is treated as completed → these workflows are NOT in the DAG
      const names = modeJson.workflows.map((w: any) => w.workflowName);
      expect(names).not.toContain("product-brief");
      expect(names).not.toContain("brainstorm");
      expect(names).not.toContain("research");
      // prd is "required" → still in the DAG
      expect(names).toContain("prd");

      // prd depends on product-brief, which is "skipped" (completed) → dep is SATISFIED
      const prdWorkflow = modeJson.workflows.find(
        (w: any) => w.workflowName === "prd",
      );
      expect(prdWorkflow).toBeDefined();
      expect(prdWorkflow.dependsOn).toEqual([]); // product-brief skipped → dep satisfied
    });

    // =========================================================================
    // 10. Goal file → parse round-trip preserves BMAD dependencies
    // =========================================================================
    it("BMAD goal files round-trip through serialize/parse preserving dependencies", async () => {
      await writeBmadConfig(2, "RoundtripTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      const piDir = join(repo, PI_AGENT_DIR);
      const goalFiles = (await readdir(piDir)).filter(
        (f) => f.startsWith("bmad-") && f.endsWith(".md"),
      );

      for (const gf of goalFiles) {
        const raw = await readFile(join(piDir, gf), "utf-8");
        const parsed = parseGoalFile(raw, gf);

        // Re-serialize and re-parse
        const reserialized = serializeGoalFile(parsed);
        const reparsed = parseGoalFile(reserialized, gf);

        // Core fields preserved
        expect(reparsed.name).toBe(parsed.name);
        expect(reparsed.role).toBe(parsed.role);
        expect(reparsed.goals.length).toBe(parsed.goals.length);
        for (let i = 0; i < parsed.goals.length; i++) {
          expect(reparsed.goals[i].text).toBe(parsed.goals[i].text);
          expect(reparsed.goals[i].completed).toBe(parsed.goals[i].completed);
        }

        // Dependencies preserved
        if (parsed.dependsOn && parsed.dependsOn.length > 0) {
          expect(reparsed.dependsOn).toEqual(parsed.dependsOn);
          // All BMAD deps should use the bmad- prefix
          for (const dep of reparsed.dependsOn!) {
            expect(dep).toMatch(/^bmad-/);
          }
        }

        // Context preserved
        expect(reparsed.context).toBe(parsed.context);
      }
    });

    // =========================================================================
    // 11. Mailbox directories created for ALL workflows, not just active ones
    // =========================================================================
    it("mailbox directories created for all DAG workflows including queued ones", async () => {
      await writeBmadConfig(2, "MailboxTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      // Read .bmad-mode.json to get all workflow names
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );

      // Every workflow (active + pending) should have a mailbox directory
      const mailboxDir = join(repo, MAILBOX_DIR);
      for (const w of modeJson.workflows) {
        let mailboxExists = false;
        try {
          const entries = await readdir(join(mailboxDir, w.name));
          mailboxExists = true;
        } catch {
          // Directory doesn't exist
        }
        expect(mailboxExists).toBe(true);
      }

      // Manager mailbox should also exist
      let managerMailbox = false;
      try {
        await readdir(join(mailboxDir, "manager"));
        managerMailbox = true;
      } catch {
        /* */
      }
      expect(managerMailbox).toBe(true);
    });

    // =========================================================================
    // 12. Workflow with no WORKFLOW_PROMPTS entry gets fallback prompt
    // =========================================================================
    it("workflow without WORKFLOW_PROMPTS entry gets sensible fallback prompt", async () => {
      // This tests the fallback path in buildBmadWorkerPrompt where
      // WORKFLOW_PROMPTS[name] is undefined. We can test this indirectly:
      // the "solutioning-gate-check" workflow IS in WORKFLOW_PROMPTS, so let's
      // verify all generated prompts contain meaningful content (not just the
      // fallback stub). This is more of a sanity check.
      await writeBmadConfig(2, "FallbackTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
      const promptFiles = (await readdir(promptsDir)).filter((f) =>
        f.endsWith(".md"),
      );

      for (const pf of promptFiles) {
        const content = await readFile(join(promptsDir, pf), "utf-8");
        // Every prompt should have substantial content (not just the 3-line fallback)
        expect(content.length).toBeGreaterThan(500);
        // Every prompt should have the BMAD header
        expect(content).toMatch(/## (Autonomous BMAD Worker|BMAD:)/);
        // Every prompt should have harness worker instructions
        expect(content).toContain("## Harness Worker Instructions");
        // Every prompt should have mailbox section
        expect(content).toContain("## Mailbox");
        // Every prompt should have "When Complete" section
        expect(content).toContain("## When Complete");
        expect(content).toContain("bmad_save_document");
        expect(content).toContain("bmad_update_status");
      }
    });

    // =========================================================================
    // 13. Registry only contains spawned workers, not queued ones
    // =========================================================================
    it("registry contains only spawned (active) workers, not queued workers", async () => {
      await writeBmadConfig(2, "RegistryTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 2", ctx);

      const registry = await readRegistry(repo);
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );

      const activeWorkflows = modeJson.workflows.filter(
        (w: any) => w.status === "active",
      );
      const pendingWorkflows = modeJson.workflows.filter(
        (w: any) => w.status === "pending",
      );

      // Registry should only have active workers (+ possibly manager)
      const registryNames = Object.keys(registry.workers);
      for (const aw of activeWorkflows) {
        expect(registryNames).toContain(aw.name);
      }
      for (const pw of pendingWorkflows) {
        expect(registryNames).not.toContain(pw.name);
      }
    });

    // =========================================================================
    // 14. Queue items have correct metadata for BMAD workflows
    // =========================================================================
    it("queued BMAD workflows have correct role, goals, and description in queue", async () => {
      await writeBmadConfig(0, "QueueMetaTest");
      await writeStatusFile([
        { name: "tech-spec", phase: 2, status: "required" },
        { name: "sprint-planning", phase: 4, status: "required" },
        { name: "create-story", phase: 4, status: "required" },
        { name: "dev-story", phase: 4, status: "required" },
      ]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 1", ctx);

      // Only tech-spec should be active, rest queued
      const queue = await readQueue(repo);

      // Should have 3 queued items (sprint-planning, create-story, dev-story)
      expect(queue.items.length).toBe(3);

      for (const item of queue.items) {
        // Topic should be the worker name (bmad-prefixed)
        expect(item.topic).toMatch(/^bmad-/);
        // Should have a role
        expect(item.role).toBeDefined();
        expect(typeof item.role).toBe("string");
        // Should have goals
        expect(item.goals.length).toBeGreaterThan(0);
        // Description should mention BMAD workflow
        expect(item.description).toContain("BMAD workflow");
        // Status should be pending
        expect(item.status).toBe("pending");
      }

      // Verify specific role mappings in queue
      const sprintItem = queue.items.find(
        (i) => i.topic === "bmad-sprint-planning",
      );
      expect(sprintItem).toBeDefined();
      expect(sprintItem!.role).toBe("planner"); // Scrum Master → planner

      const devItem = queue.items.find((i) => i.topic === "bmad-dev-story");
      expect(devItem).toBeDefined();
      expect(devItem!.role).toBe("developer"); // Developer → developer
    });

    // =========================================================================
    // 15. Full L2 waterfall: simulate worker completions, verify unblocking cascade
    // =========================================================================
    it("simulated completion cascade: completing Phase 1 unblocks Phase 2 deps correctly", async () => {
      // L2 project: product-brief → prd → architecture → sprint → story → dev
      // NOTE: At L2, tech-spec is NOT in the plan. Architecture depends on [prd, tech-spec]
      // but since tech-spec is out-of-plan, only prd matters.
      await writeBmadConfig(2, "CascadeTest");
      await writeStatusFile([]);

      const { mock, ctx } = freshBmadHarness();
      await mock.emit("session_start", {}, ctx);
      interceptPiSpawns(mock);

      const bmadCmd = mock.getCommand("harness:bmad")!;
      await bmadCmd.handler("--max-workers 10", ctx);

      // Snapshot: Phase 1 workflows (product-brief, brainstorm, research) are ready
      const modeJson = JSON.parse(
        await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
      );
      const phase1Active = modeJson.workflows
        .filter((w: any) => w.status === "active")
        .map((w: any) => w.workflowName);

      // Phase 1 workflows should be active (no deps)
      expect(phase1Active).toContain("product-brief");
      expect(phase1Active).toContain("brainstorm");
      expect(phase1Active).toContain("research");

      // Phase 2 workflows (prd, create-ux-design) should be pending — they depend on product-brief
      const prdW = modeJson.workflows.find(
        (w: any) => w.workflowName === "prd",
      );
      expect(prdW.status).toBe("pending");

      // Verify tech-spec is NOT in the L2 plan at all
      const techW = modeJson.workflows.find(
        (w: any) => w.workflowName === "tech-spec",
      );
      expect(techW).toBeUndefined();

      // Now simulate: Phase 1 completes.
      const { WORKFLOW_DEFS } = await import("./bmad.js");
      const dagAfterPhase1 = buildBmadWorkflowDag(
        2,
        [
          { name: "product-brief", status: "docs/product-brief.md" },
          { name: "brainstorm", status: "docs/brainstorm.md" },
          { name: "research", status: "docs/research.md" },
        ],
        WORKFLOW_DEFS,
      );

      // prd should now have NO deps (product-brief completed)
      const prdSpec = dagAfterPhase1.find((s) => s.workflowName === "prd");
      expect(prdSpec).toBeDefined();
      expect(prdSpec!.dependsOn).toEqual([]);

      // create-ux-design depends on prd which is NOT completed yet → dep is unmet
      const uxSpec = dagAfterPhase1.find(
        (s) => s.workflowName === "create-ux-design",
      );
      expect(uxSpec).toBeDefined();
      expect(uxSpec!.dependsOn).toEqual(["prd"]);

      // architecture depends on [prd, tech-spec]. tech-spec out-of-plan → only prd matters.
      // prd is not completed → dep unmet
      const archSpec = dagAfterPhase1.find(
        (s) => s.workflowName === "architecture",
      );
      expect(archSpec).toBeDefined();
      expect(archSpec!.dependsOn).toEqual(["prd"]);

      // Now simulate: prd completes
      const dagAfterPrd = buildBmadWorkflowDag(
        2,
        [
          { name: "product-brief", status: "docs/product-brief.md" },
          { name: "brainstorm", status: "docs/brainstorm.md" },
          { name: "research", status: "docs/research.md" },
          { name: "prd", status: "docs/prd.md" },
        ],
        WORKFLOW_DEFS,
      );

      // architecture: prd completed, tech-spec out-of-plan → NO deps
      const finalArch = dagAfterPrd.find(
        (s) => s.workflowName === "architecture",
      );
      expect(finalArch).toBeDefined();
      expect(finalArch!.dependsOn).toEqual([]);

      // create-ux-design: prd completed → NO deps
      const finalUx = dagAfterPrd.find(
        (s) => s.workflowName === "create-ux-design",
      );
      expect(finalUx).toBeDefined();
      expect(finalUx!.dependsOn).toEqual([]);

      // sprint-planning depends on [architecture, tech-spec]. tech-spec out-of-plan → only architecture
      // architecture not completed → dep unmet
      const finalSprint = dagAfterPrd.find(
        (s) => s.workflowName === "sprint-planning",
      );
      expect(finalSprint).toBeDefined();
      expect(finalSprint!.dependsOn).toEqual(["architecture"]);

      // solutioning-gate-check depends on architecture (not completed) → dep unmet
      const finalGate = dagAfterPrd.find(
        (s) => s.workflowName === "solutioning-gate-check",
      );
      expect(finalGate).toBeDefined();
      expect(finalGate!.dependsOn).toEqual(["architecture"]);
    });
  },
);

// ---------------------------------------------------------------------------
// /harness:auto integration
// ---------------------------------------------------------------------------

describe("/harness:auto integration", () => {
  let parentRepo: string;
  let mockPi: ReturnType<typeof createMockExtensionAPI>;

  beforeAll(async () => {
    parentRepo = await mkdtemp(join(tmpdir(), "harness-auto-int-"));
    git("init", parentRepo);
    git('config user.email "test@test.com"', parentRepo);
    git('config user.name "Test"', parentRepo);
    await writeFile(join(parentRepo, "README.md"), "# Test\n");
    git("add -A", parentRepo);
    git('commit -m "init"', parentRepo);
  });

  afterAll(async () => {
    // Kill any tmux sessions we may have started
    try {
      execSync("tmux -L pi-harness kill-server 2>/dev/null", {
        encoding: "utf-8",
      });
    } catch {
      /* no sessions */
    }
    await rm(parentRepo, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mockPi = createMockExtensionAPI();
    // Clean up state from previous tests
    try {
      execSync("tmux -L pi-harness kill-server 2>/dev/null", {
        encoding: "utf-8",
      });
    } catch {
      /* no sessions */
    }
    // Prune worktrees and remove leftover branches/state
    try {
      git("worktree prune", parentRepo);
    } catch {
      /* ok */
    }
    try {
      await rm(join(parentRepo, PI_AGENT_DIR), {
        recursive: true,
        force: true,
      });
    } catch {
      /* ok */
    }
    try {
      const branches = git("branch --list 'pi-agent/*'", parentRepo);
      for (const b of branches
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        try {
          git(`branch -D ${b}`, parentRepo);
        } catch {
          /* ok */
        }
      }
    } catch {
      /* no branches */
    }
  });

  it(
    "full auto lifecycle: spawn scout → simulate completion → verify goal files created",
    { timeout: 30_000 },
    async () => {
      initExtension(mockPi.api as any);
      const ctx = createMockContext(parentRepo);

      // Initialize session
      await mockPi.emit("session_start", {}, ctx);

      // Run /harness:auto with minimal stagger to speed up the test
      const autoCmd = mockPi.getCommand("harness:auto");
      expect(autoCmd).toBeDefined();
      await autoCmd!.handler(
        "--max-workers 2 --stagger 100 improve test coverage",
        ctx,
      );

      // Verify auto mode state was written
      const stateContent = await readFile(
        join(parentRepo, AUTO_MODE_FILE),
        "utf-8",
      );
      const state = JSON.parse(stateContent) as AutoModeState;
      expect(state.enabled).toBe(true);
      expect(state.phase).toBe("scouting");
      expect(state.config.objective).toBe("improve test coverage");
      expect(state.config.maxWorkers).toBe(2);

      // Verify scout goal file was created
      const scoutGoal = await readFile(
        join(parentRepo, PI_AGENT_DIR, "scout.md"),
        "utf-8",
      );
      expect(scoutGoal).toContain("# scout");
      expect(scoutGoal).toContain("Evaluate the codebase");

      // Verify scout worktree was created
      const worktreePath = join(parentRepo, WORKTREE_DIR, "scout");
      const promptFile = await readFile(
        join(worktreePath, ".pi-agent-prompt.md"),
        "utf-8",
      );
      expect(promptFile).toContain("Investigation Checklist");
      expect(promptFile).toContain("improve test coverage");

      // Simulate scout completion: write analysis and mark goal done
      const analysis: ScoutAnalysis = {
        timestamp: new Date().toISOString(),
        objective: "improve test coverage",
        repoSummary: {
          name: "test-repo",
          languages: ["typescript"],
          hasTests: true,
          testFramework: "vitest",
          hasCI: false,
          recentCommits: 5,
          openTodoCount: 3,
        },
        findings: [
          {
            id: "test-gap-auth",
            category: "tests",
            severity: "high",
            title: "Missing auth tests",
            description: "Auth module has no unit tests",
            evidence: ["src/auth.ts"],
            suggestedRole: "tester",
            estimatedGoals: [
              "Write unit tests for auth module",
              "Add integration tests",
            ],
          },
          {
            id: "cleanup-todos",
            category: "cleanup",
            severity: "low",
            title: "Remove TODOs",
            description: "Several TODO comments in codebase",
            evidence: ["src/index.ts", "src/utils.ts"],
            suggestedRole: "developer",
            estimatedGoals: ["Resolve TODO comments"],
          },
        ],
      };

      await writeFile(
        join(parentRepo, SCOUT_ANALYSIS_FILE),
        JSON.stringify(analysis, null, 2),
      );

      // Mark scout goal as complete
      const completedGoal =
        "# scout\npath: .\nrole: researcher\n\n## Goals\n- [x] Evaluate the codebase and produce a scout analysis\n\n## Context\nimprove test coverage\n";
      await writeFile(
        join(parentRepo, PI_AGENT_DIR, "scout.md"),
        completedGoal,
      );

      // Trigger turn_end to detect scout completion
      await mockPi.emit("turn_end", {}, ctx);

      // Verify auto state was updated to executing
      const updatedState = JSON.parse(
        await readFile(join(parentRepo, AUTO_MODE_FILE), "utf-8"),
      ) as AutoModeState;
      expect(updatedState.phase).toBe("executing");
      expect(updatedState.planApproved).toBe(true);

      // Verify goal files were created from analysis findings
      const testGapGoal = await readFile(
        join(parentRepo, PI_AGENT_DIR, "test-gap-auth.md"),
        "utf-8",
      );
      expect(testGapGoal).toContain("test-gap-auth");
      expect(testGapGoal).toContain("Write unit tests for auth module");

      const cleanupGoal = await readFile(
        join(parentRepo, PI_AGENT_DIR, "cleanup-todos.md"),
        "utf-8",
      );
      expect(cleanupGoal).toContain("cleanup-todos");
      expect(cleanupGoal).toContain("Resolve TODO comments");

      // Clean up — cancel to stop everything
      await autoCmd!.handler("cancel", ctx);
    },
  );

  it("cancel sub-command cleans up scout and state files", async () => {
    initExtension(mockPi.api as any);
    const ctx = createMockContext(parentRepo);
    await mockPi.emit("session_start", {}, ctx);

    const autoCmd = mockPi.getCommand("harness:auto");
    await autoCmd!.handler("evaluate codebase", ctx);

    // Verify scout is running
    let stateContent = await readFile(
      join(parentRepo, AUTO_MODE_FILE),
      "utf-8",
    );
    let state = JSON.parse(stateContent) as AutoModeState;
    expect(state.enabled).toBe(true);

    // Cancel
    await autoCmd!.handler("cancel", ctx);

    // Verify auto mode file is cleaned up
    let autoFileExists = true;
    try {
      await readFile(join(parentRepo, AUTO_MODE_FILE));
    } catch {
      autoFileExists = false;
    }
    expect(autoFileExists).toBe(false);

    // Verify scout goal file is cleaned up
    let scoutGoalExists = true;
    try {
      await readFile(join(parentRepo, PI_AGENT_DIR, "scout.md"));
    } catch {
      scoutGoalExists = false;
    }
    expect(scoutGoalExists).toBe(false);
  });

  it("re-scout iteration increments counter and respawns scout", async () => {
    initExtension(mockPi.api as any);
    const ctx = createMockContext(parentRepo);
    await mockPi.emit("session_start", {}, ctx);

    const autoCmd = mockPi.getCommand("harness:auto");
    await autoCmd!.handler("--max-iterations 2 evaluate", ctx);

    // Simulate scout completing with a single finding
    const analysis: ScoutAnalysis = {
      timestamp: new Date().toISOString(),
      repoSummary: {
        name: "test-repo",
        languages: ["typescript"],
        hasTests: true,
        hasCI: false,
        recentCommits: 5,
        openTodoCount: 0,
      },
      findings: [
        {
          id: "quick-fix",
          category: "bugs",
          severity: "high",
          title: "Quick fix",
          description: "Simple bug fix",
          evidence: ["src/bug.ts"],
          suggestedRole: "developer",
          estimatedGoals: ["Fix the bug"],
        },
      ],
    };

    await writeFile(
      join(parentRepo, SCOUT_ANALYSIS_FILE),
      JSON.stringify(analysis, null, 2),
    );
    await writeFile(
      join(parentRepo, PI_AGENT_DIR, "scout.md"),
      "# scout\npath: .\nrole: researcher\n\n## Goals\n- [x] Evaluate the codebase and produce a scout analysis\n",
    );

    // turn_end detects scout completion → executes plan
    await mockPi.emit("turn_end", {}, ctx);

    let state = JSON.parse(
      await readFile(join(parentRepo, AUTO_MODE_FILE), "utf-8"),
    ) as AutoModeState;
    expect(state.phase).toBe("executing");
    expect(state.iteration).toBe(0);

    // Simulate all_complete by writing manager status
    const managerStatus: ManagerStatusFile = {
      status: "all_complete",
      updatedAt: new Date().toISOString(),
      submodules: {
        "quick-fix": { completed: 1, total: 1, allDone: true },
      },
      stallCount: 0,
    };
    await mkdir(join(parentRepo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(parentRepo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    // turn_end detects all_complete → triggers re-scout
    await mockPi.emit("turn_end", {}, ctx);

    state = JSON.parse(
      await readFile(join(parentRepo, AUTO_MODE_FILE), "utf-8"),
    ) as AutoModeState;
    expect(state.phase).toBe("re-scouting");
    expect(state.iteration).toBe(1);
    expect(state.config.iteration).toBe(1);

    // Scout goal file should exist again for re-scout
    const scoutGoal = await readFile(
      join(parentRepo, PI_AGENT_DIR, "scout.md"),
      "utf-8",
    );
    expect(scoutGoal).toContain("scout");

    // Clean up
    await autoCmd!.handler("cancel", ctx);
  });
});

// ---------------------------------------------------------------------------
// Trace logging e2e: real git repos, real events, real log files
// ---------------------------------------------------------------------------

describe("trace logging e2e", { timeout: 30_000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-trace-e2e-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);
    execSync(
      `echo "# Trace E2E" > README.md && git add . && git commit -m "init"`,
      { cwd: repo, shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  afterAll(async () => {
    // Kill any tmux sessions
    try {
      execSync("tmux -L pi-harness kill-server 2>/dev/null", {
        encoding: "utf-8",
      });
    } catch {
      /* no sessions */
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up state
    try {
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      /* ok */
    }
    try {
      git("worktree prune", repo);
    } catch {
      /* ok */
    }
    try {
      const branches = git("branch --list 'pi-agent/*'", repo);
      for (const b of branches
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)) {
        try {
          git(`branch -D ${b}`, repo);
        } catch {
          /* ok */
        }
      }
    } catch {
      /* no branches */
    }
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
    return originalExec;
  }

  /** Parse NDJSON log file into entries */
  async function readTraceLog(): Promise<HarnessLogEntry[]> {
    try {
      const raw = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as HarnessLogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is HarnessLogEntry => e !== null);
    } catch {
      return [];
    }
  }

  // ---- Test 1: session lifecycle produces session.start + session.shutdown ----

  it("session_start and session_shutdown produce trace entries", async () => {
    const { mock, ctx } = freshHarness();

    await mock.emit("session_start", {}, ctx);
    await mock.emit("session_shutdown", {}, {});

    // Give fire-and-forget appendFile a tick
    await new Promise((r) => setTimeout(r, 100));

    const entries = await readTraceLog();
    const sessionStart = entries.find((e) => e.event === "session.start");
    expect(sessionStart).toBeDefined();
    expect(sessionStart!.level).toBe("info");
    expect(sessionStart!.data?.cwd).toBe(repo);

    const sessionShutdown = entries.find((e) => e.event === "session.shutdown");
    expect(sessionShutdown).toBeDefined();
    expect(sessionShutdown!.level).toBe("info");
    expect(sessionShutdown!.data).toHaveProperty("sessions");
    expect(sessionShutdown!.data).toHaveProperty("loopActive");
  });

  // ---- Test 2: tool_call event auto-captures tool invocations ----

  it("tool_call event captures tool name and summarized input", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Simulate a tool call event
    await mock.emit(
      "tool_call",
      {
        toolName: "harness_update_goal",
        input: { name: "auth-api", action: "complete", goalIndex: 0 },
      },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 100));

    const entries = await readTraceLog();
    const toolCall = entries.find((e) => e.event === "tool.call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.data?.tool).toBe("harness_update_goal");
    expect(toolCall!.data?.name).toBe("auth-api");
    expect(toolCall!.data?.action).toBe("complete");
  });

  // ---- Test 3: tool_call truncates large string values to 200 chars ----

  it("tool_call truncates large input values", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const longString = "x".repeat(500);
    await mock.emit(
      "tool_call",
      {
        toolName: "some_tool",
        input: { bigField: longString },
      },
      ctx,
    );

    await new Promise((r) => setTimeout(r, 100));

    const entries = await readTraceLog();
    const toolCall = entries.find((e) => e.event === "tool.call");
    expect(toolCall).toBeDefined();
    expect((toolCall!.data?.bigField as string).length).toBe(200);
  });

  // ---- Test 4: turn_end captures context usage ----

  it("turn_end captures token usage from getContextUsage", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // turn_end — note there are 2 turn_end handlers: the harness one
    // (which only runs when loopActive) and our trace one (always runs).
    await mock.emit("turn_end", {}, ctx);

    await new Promise((r) => setTimeout(r, 100));

    const entries = await readTraceLog();
    const turnEnd = entries.find((e) => e.event === "turn.end");
    expect(turnEnd).toBeDefined();
    expect(turnEnd!.data?.tokens).toBe(5000);
    expect(turnEnd!.data?.percent).toBe(5);
  });

  // ---- Test 5: agent_end event captured ----

  it("agent_end event is logged", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    await mock.emit("agent_end", {}, ctx);

    await new Promise((r) => setTimeout(r, 100));

    const entries = await readTraceLog();
    const agentEnd = entries.find((e) => e.event === "agent.end");
    expect(agentEnd).toBeDefined();
    expect(agentEnd!.level).toBe("debug");
  });

  // ---- Test 6: full /harness:add + /harness:launch captures worker traces ----

  it("launch lifecycle produces worker.worktree.created, worker.spawn, state.persist, manager.spawn traces", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create a task
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("trace-worker Implement trace logging", ctx);

    // Launch
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog();
    const events = entries.map((e) => e.event);

    // Should have session.start
    expect(events).toContain("session.start");

    // Should have worker lifecycle traces
    expect(events).toContain("worker.worktree.created");
    expect(events).toContain("worker.spawn");

    // Should have manager spawn
    expect(events).toContain("manager.spawn");

    // Should have state persistence
    expect(events).toContain("state.persist");

    // Verify worker.worktree.created has name and branch data
    const worktreeEntry = entries.find(
      (e) => e.event === "worker.worktree.created",
    );
    expect(worktreeEntry!.data?.name).toBe("trace-worker");
    expect(worktreeEntry!.data?.branch).toBe("pi-agent/trace-worker");

    // Verify worker.spawn has role and goals count
    const spawnEntry = entries.find((e) => e.event === "worker.spawn");
    expect(spawnEntry!.data?.name).toBe("trace-worker");
    expect(spawnEntry!.data?.role).toBeDefined();
    expect(spawnEntry!.data?.goals).toBe(1);

    // Verify manager.spawn has workers list
    const mgrEntry = entries.find((e) => e.event === "manager.spawn");
    expect(mgrEntry!.data?.workers).toEqual(
      expect.arrayContaining(["trace-worker"]),
    );

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 7: /harness:auto captures auto.scout.start trace ----

  it("/harness:auto produces auto.scout.start trace", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const autoCmd = mock.getCommand("harness:auto")!;
    await autoCmd.handler("--max-workers 2 --stagger 100 improve testing", ctx);

    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog();
    const scoutStart = entries.find((e) => e.event === "auto.scout.start");
    expect(scoutStart).toBeDefined();
    expect(scoutStart!.level).toBe("info");
    expect(scoutStart!.data?.objective).toBe("improve testing");

    // Clean up
    await autoCmd.handler("cancel", ctx);
  });

  // ---- Test 8: auto mode scout complete + execute plan traces ----

  it("auto scout completion produces auto.scout.complete and auto.plan.execute traces", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const autoCmd = mock.getCommand("harness:auto")!;
    await autoCmd.handler("--max-workers 2 --stagger 0 test coverage", ctx);

    // Simulate scout completion
    const analysis: ScoutAnalysis = {
      timestamp: new Date().toISOString(),
      objective: "test coverage",
      repoSummary: {
        name: "test-repo",
        languages: ["typescript"],
        hasTests: true,
        testFramework: "vitest",
        hasCI: false,
        recentCommits: 5,
        openTodoCount: 0,
      },
      findings: [
        {
          id: "add-tests",
          category: "tests",
          severity: "high",
          title: "Missing tests",
          description: "No tests for core module",
          evidence: ["src/core.ts"],
          suggestedRole: "tester",
          estimatedGoals: ["Write unit tests"],
        },
      ],
    };

    await writeFile(join(repo, SCOUT_ANALYSIS_FILE), JSON.stringify(analysis));
    await writeFile(
      join(repo, PI_AGENT_DIR, "scout.md"),
      "# scout\npath: .\nrole: researcher\n\n## Goals\n- [x] Evaluate the codebase and produce a scout analysis\n\n## Context\ntest coverage\n",
    );

    // turn_end detects scout completion
    await mock.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog();
    const events = entries.map((e) => e.event);

    expect(events).toContain("auto.scout.complete");
    expect(events).toContain("auto.plan.execute");

    // Verify auto.scout.complete has findings count
    const completeEntry = entries.find(
      (e) => e.event === "auto.scout.complete",
    );
    expect(completeEntry!.data?.findings).toBe(1);
    expect(completeEntry!.level).toBe("info");

    // Verify auto.plan.execute has ready/queued counts
    const planEntry = entries.find((e) => e.event === "auto.plan.execute");
    expect(planEntry!.data).toHaveProperty("ready");
    expect(planEntry!.data).toHaveProperty("queued");
    expect(planEntry!.level).toBe("info");

    // Clean up
    await autoCmd.handler("cancel", ctx);
  });

  // ---- Test 9: /harness:trace command reads and filters real log ----

  it("/harness:trace reads and filters the real trace log", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Add + launch to generate some traces
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("filter-test Write filter tests", ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await new Promise((r) => setTimeout(r, 200));

    // Now use /harness:trace to read the log
    mock.api.sendMessage.mockClear();
    const traceCmd = mock.getCommand("harness:trace")!;
    await traceCmd.handler("", ctx);

    // Should have sent a message with trace content
    const traceCall = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-trace",
    );
    expect(traceCall).toBeDefined();
    expect(traceCall![0].content).toContain("Trace Log");
    expect(traceCall![0].content).toContain("session.start");

    // Test filtering — filter for worker events only
    mock.api.sendMessage.mockClear();
    await traceCmd.handler("--filter worker", ctx);
    const filteredCall = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-trace",
    );
    expect(filteredCall).toBeDefined();
    expect(filteredCall![0].content).toContain("worker.");
    // Should NOT contain session or manager events in the output
    // (they may appear in the log, but filtered out)
    const filteredContent = filteredCall![0].content as string;
    const filteredLines = filteredContent
      .split("\n")
      .filter((line: string) => line.startsWith("[") && line.includes("]"));
    for (const line of filteredLines) {
      expect(line).toContain("worker.");
    }

    // Test level filter
    mock.api.sendMessage.mockClear();
    await traceCmd.handler("--level info", ctx);
    const levelCall = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-trace",
    );
    expect(levelCall).toBeDefined();
    expect(levelCall![0].content).toContain("INFO");

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 10: /harness:cleanup removes trace log file ----

  it("/harness:cleanup removes the trace log file", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Generate some traces
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("cleanup-trace-test Do a thing", ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await new Promise((r) => setTimeout(r, 200));

    // Verify log exists
    const entriesBefore = await readTraceLog();
    expect(entriesBefore.length).toBeGreaterThan(0);

    // Cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Verify log is gone
    const entriesAfter = await readTraceLog();
    expect(entriesAfter.length).toBe(0);
  });

  // ---- Test 11: all NDJSON entries are well-formed ----

  it("all logged entries are valid NDJSON with required fields", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Generate diverse traces
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("json-test Write valid JSON, Parse data", ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await mock.emit(
      "tool_call",
      { toolName: "read_file", input: { path: "/foo" } },
      ctx,
    );
    await mock.emit("turn_end", {}, ctx);
    await mock.emit("agent_end", {}, ctx);
    await mock.emit("session_shutdown", {}, {});

    await new Promise((r) => setTimeout(r, 200));

    // Read raw log — every non-empty line must parse as valid JSON
    const raw = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(5); // should have many entries

    for (const line of lines) {
      const entry = JSON.parse(line); // throws if invalid JSON
      // Required fields
      expect(entry).toHaveProperty("ts");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("event");
      // ts is ISO-8601
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
      // level is one of the valid values
      expect(["debug", "info", "warn", "error"]).toContain(entry.level);
      // event is a non-empty string
      expect(typeof entry.event).toBe("string");
      expect(entry.event.length).toBeGreaterThan(0);
      // data, if present, is an object
      if (entry.data !== undefined) {
        expect(typeof entry.data).toBe("object");
        expect(entry.data).not.toBeNull();
      }
    }

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 12: config.reload trace is produced on config change ----

  it("config.reload trace is produced when runtime config changes", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create task and launch to activate loopActive
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("config-test Run config test", ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Write a runtime config change
    await writeFile(
      join(repo, ".pi-agent/.harness-config.json"),
      JSON.stringify({ maxWorkers: 5, staggerMs: 1000 }),
    );

    // Write a manager status so turn_end processes fully
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: {},
        stallCount: 0,
      }),
    );

    // Trigger turn_end (which calls checkConfigReload)
    await mock.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog();
    const configReload = entries.find((e) => e.event === "config.reload");
    expect(configReload).toBeDefined();
    expect(configReload!.data?.changes).toBeDefined();

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 13: /harness:trace --clear works on real log ----

  it("/harness:trace --clear truncates the real log", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);
    await new Promise((r) => setTimeout(r, 100));

    // Verify log has content
    const entriesBefore = await readTraceLog();
    expect(entriesBefore.length).toBeGreaterThan(0);

    // Clear it
    const traceCmd = mock.getCommand("harness:trace")!;
    await traceCmd.handler("--clear", ctx);

    // Log should now be empty
    const content = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
    expect(content).toBe("");
  });

  // ---- Test 14: chronological ordering ----

  it("trace entries are in chronological order", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("chrono-test A thing", ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    await mock.emit("tool_call", { toolName: "test_tool", input: {} }, ctx);
    await mock.emit("turn_end", {}, ctx);
    await mock.emit("session_shutdown", {}, {});

    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog();
    for (let i = 1; i < entries.length; i++) {
      const prev = new Date(entries[i - 1].ts).getTime();
      const curr = new Date(entries[i].ts).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });
});

// ---------------------------------------------------------------------------
// Claude backend e2e: launch + BMAD with --backend claude
// ---------------------------------------------------------------------------

describe("Claude backend e2e", { timeout: 30000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "harness-claude-e2e-"));
    repo = join(baseDir, "claude-test-project");
    execSync(
      [
        `git init ${repo}`,
        `cd ${repo}`,
        'git config user.email "test@test.com"',
        'git config user.name "Test"',
        'echo "# Claude Backend Test" > README.md',
        "git add .",
        'git commit -m "initial commit"',
      ].join(" && "),
      { shell: "/bin/bash", encoding: "utf-8" },
    );
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up harness state between tests
    try {
      const wtDir = join(repo, WORKTREE_DIR);
      try {
        const entries = await readdir(wtDir);
        for (const entry of entries) {
          try {
            git(`worktree remove ${join(wtDir, entry)} --force`, repo);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* worktree dir may not exist */
      }
      try {
        git("worktree prune", repo);
      } catch {
        /* ignore */
      }
      try {
        const branches = git("branch --list pi-agent/*", repo);
        for (const branch of branches.split("\n")) {
          const b = branch.trim();
          if (b) {
            try {
              git(`branch -D ${b}`, repo);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      /* first test — nothing to clean */
    }
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function interceptSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "pi" || cmd === "claude" || cmd === "tmux") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
  }

  function getTmuxNewSessionCalls(
    mock: ReturnType<typeof createMockExtensionAPI>,
  ) {
    return mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );
  }

  function getTmuxShellCmd(tmuxCall: any[]): string {
    // tmux args: ["-L", server, "new-session", "-d", "-s", name, "-c", cwd, "bash", "-c", cmd]
    const args = tmuxCall[1] as string[];
    const bashIdx = args.indexOf("bash");
    return bashIdx >= 0 && args[bashIdx + 1] === "-c" ? args[bashIdx + 2] : "";
  }

  it("/harness:launch --backend claude spawns workers with claude -p instead of pi -p", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create a goal file
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "task-alpha.md"),
      [
        "# task-alpha",
        "",
        "## Goals",
        "- [ ] Implement feature alpha",
        "- [ ] Write tests for alpha",
      ].join("\n"),
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler(
      "--backend claude --claude-model claude-sonnet-4-5-20250514 --claude-budget 5",
      ctx,
    );

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    // 1 worker + 1 manager = 2 tmux sessions
    expect(tmuxCalls.length).toBe(2);

    // Worker session should use `claude -p` not `pi -p`
    const workerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a.includes("worker-")),
    );
    expect(workerCall).toBeDefined();
    const workerCmd = getTmuxShellCmd(workerCall!);
    expect(workerCmd).toContain("claude -p");
    expect(workerCmd).toContain("--model claude-sonnet-4-5-20250514");
    expect(workerCmd).toContain("--max-budget-usd 5");
    expect(workerCmd).not.toMatch(/^pi\s/);

    // Manager loop should also use `claude -p`
    const managerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a === "harness-manager"),
    );
    expect(managerCall).toBeDefined();
    const managerCmd = getTmuxShellCmd(managerCall!);
    expect(managerCmd).toContain("claude -p");
    expect(managerCmd).toContain("while true; do");
    expect(managerCmd).toContain("--model claude-sonnet-4-5-20250514");

    // harness_status should report backend
    const statusTool = mock.getTool("harness_status")!;
    const statusResult = await statusTool.execute("c1", {});
    expect(statusResult.details.backend).toBe("claude");

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("/harness:launch default backend is pi — existing behavior preserved", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "task-beta.md"),
      "# task-beta\n\n## Goals\n- [ ] Do something\n",
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    expect(tmuxCalls.length).toBe(2);

    // Worker should use `pi -p`
    const workerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a.includes("worker-")),
    );
    const workerCmd = getTmuxShellCmd(workerCall!);
    expect(workerCmd).toContain("pi");
    expect(workerCmd).toContain('-p "$(cat .pi-agent-prompt.md)"');
    expect(workerCmd).not.toMatch(/\bclaude\s+-p/);

    // Manager should use `pi -p`
    const managerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a === "harness-manager"),
    );
    const managerCmd = getTmuxShellCmd(managerCall!);
    expect(managerCmd).toContain("pi -p");
    expect(managerCmd).not.toMatch(/\bclaude\s+-p/);

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("state persistence round-trips backend and claudeConfig", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "task-persist.md"),
      "# task-persist\n\n## Goals\n- [ ] Persist test\n",
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--backend claude --claude-model test-model", ctx);

    // Verify state file was written with backend
    const stateRaw = await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8");
    const state = JSON.parse(stateRaw) as LaunchState;
    expect(state.backend).toBe("claude");
    expect(state.claudeConfig).toBeDefined();
    expect(state.claudeConfig?.model).toBe("test-model");

    // New harness instance should restore state
    const { mock: mock2, ctx: ctx2 } = freshHarness();
    interceptSpawns(mock2);
    await mock2.emit("session_start", {}, ctx2);

    // harness_status should report the persisted backend
    const statusTool = mock2.getTool("harness_status")!;
    const result = await statusTool.execute("c1", {});
    expect(result.details.backend).toBe("claude");

    const cleanupCmd = mock2.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx2);
  });

  it("config reload picks up backend change from .harness-config.json", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "task-reload.md"),
      "# task-reload\n\n## Goals\n- [ ] Reload test\n",
    );

    // Launch with pi (default)
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Verify initially pi
    const statusTool = mock.getTool("harness_status")!;
    let result = await statusTool.execute("c1", {});
    expect(result.details.backend).toBe("pi");

    // Write .harness-config.json with claude backend
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: { model: "claude-sonnet-4-5-20250514" },
      }),
    );

    // Trigger a turn_end to pick up config reload
    await mock.emit("turn_end", {}, ctx);

    // Now backend should be claude
    result = await statusTool.execute("c2", {});
    expect(result.details.backend).toBe("claude");

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("/harness:bmad --backend claude passes claude flags to BMAD worker spawns", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Set up minimal BMAD config
    await mkdir(join(repo, "bmad"), { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        "project_name: ClaudeTest",
        "project_type: web-app",
        "project_level: 2",
        "user_name: test-user",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
        '  sprint_status_file: "docs/sprint-status.yaml"',
        "",
        "paths:",
        "  docs: docs",
        "  stories: docs/stories",
        "  tests: tests",
      ].join("\n"),
    );
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "# BMAD Workflow Status",
        "",
        "workflow_status:",
        "  - name: product-brief",
        "    phase: 1",
        '    status: "docs/product-brief.md"',
        '    description: "Product brief"',
      ].join("\n"),
    );
    git("add . && git commit -m 'bmad config'", repo);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler(
      "--backend claude --claude-budget 10 --max-workers 2",
      ctx,
    );

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(2); // workers + manager

    // All worker tmux calls should use claude -p (not pi -p)
    for (const call of tmuxCalls) {
      const shellCmd = getTmuxShellCmd(call);
      expect(shellCmd).toMatch(/\bclaude\s+-p/);
      expect(shellCmd).not.toMatch(/\bpi\s+-p/);
    }

    // Manager loop should contain --max-budget-usd 10
    const managerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a === "harness-manager"),
    );
    if (managerCall) {
      const managerCmd = getTmuxShellCmd(managerCall);
      expect(managerCmd).toContain("--max-budget-usd 10");
    }

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("zero-to-running: /harness:add + /harness:launch --backend claude in 2 steps from empty repo", async () => {
    // Simulates a user who just cloned a repo and wants Claude-backed workers
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Step 1: /harness:add creates .pi-agent/ and goal file in one shot
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler(
      "api-refactor --role architect Extract auth middleware, Add rate limiting, Write API docs",
      ctx,
    );

    // Verify goal file created with correct role
    const goalContent = await readFile(
      join(repo, PI_AGENT_DIR, "api-refactor.md"),
      "utf-8",
    );
    const parsed = parseGoalFile(goalContent, "api-refactor.md");
    expect(parsed.role).toBe("architect");
    expect(parsed.goals).toHaveLength(3);

    // Step 2: /harness:launch --backend claude
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler(
      "--backend claude --claude-model claude-sonnet-4-5-20250514 --claude-budget 3",
      ctx,
    );

    // Verify: tmux spawned with claude binary
    const tmuxCalls = getTmuxNewSessionCalls(mock);
    expect(tmuxCalls.length).toBe(2); // 1 worker + 1 manager

    const workerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a.includes("worker-")),
    );
    const workerCmd = getTmuxShellCmd(workerCall!);
    expect(workerCmd).toMatch(/\bclaude\s+-p/);
    expect(workerCmd).toContain("--model claude-sonnet-4-5-20250514");
    expect(workerCmd).toContain("--max-budget-usd 3");

    // Verify: state persisted with backend info
    const state = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    ) as LaunchState;
    expect(state.backend).toBe("claude");
    expect(state.active).toBe(true);

    // Verify: harness-started message includes the worker name
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("api-refactor"),
      }),
      { triggerTurn: false },
    );

    const cleanupCmd2 = mock.getCommand("harness:cleanup")!;
    await cleanupCmd2.handler("--force", ctx);
  });

  it("multi-worker launch: mixed goals with dependencies, all get claude backend", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create two tasks: backend depends on schema
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("schema --role architect Design DB schema", ctx);
    await addCmd.handler("backend --role developer Implement API layer", ctx);

    // Add dependency: backend depends on schema
    const backendGoal = await readFile(
      join(repo, PI_AGENT_DIR, "backend.md"),
      "utf-8",
    );
    await writeFile(
      join(repo, PI_AGENT_DIR, "backend.md"),
      backendGoal.replace("# backend", "# backend\n\ndepends_on: schema"),
    );

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--backend claude --claude-budget 2", ctx);

    // Only schema should be spawned (backend is blocked)
    const tmuxCalls = getTmuxNewSessionCalls(mock);
    // schema worker + manager = 2
    const workerCalls = tmuxCalls.filter((c: any) =>
      (c[1] as string[]).some(
        (a: string) => a.includes("worker-") && !a.includes("harness-manager"),
      ),
    );
    expect(workerCalls.length).toBe(1);
    const schemaCmd = getTmuxShellCmd(workerCalls[0]);
    expect(schemaCmd).toMatch(/\bclaude\s+-p/);

    // Harness-started message should mention schema is launched and backend is waiting
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("schema"),
      }),
      { triggerTurn: false },
    );

    const cleanupCmd2 = mock.getCommand("harness:cleanup")!;
    await cleanupCmd2.handler("--force", ctx);
  });

  it("claude backend with --claude-permission-mode flag is passed through", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("perm-test Do something", ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler(
      "--backend claude --claude-permission-mode bypassPermissions",
      ctx,
    );

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    const workerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a.includes("worker-")),
    );
    const workerCmd = getTmuxShellCmd(workerCall!);
    expect(workerCmd).toContain("--permission-mode bypassPermissions");

    const cleanupCmd2 = mock.getCommand("harness:cleanup")!;
    await cleanupCmd2.handler("--force", ctx);
  });

  it("config-only launch: .harness-config.json sets backend without CLI flags", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("config-test Write feature X", ctx);

    // Write config file BEFORE launch — simulates pre-existing project config
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: {
          model: "claude-sonnet-4-5-20250514",
          permissionMode: "bypassPermissions",
          maxBudgetUsd: 10,
        },
      }),
    );

    // Trigger config reload via turn_end (picks up .harness-config.json)
    await mock.emit("turn_end", {}, ctx);

    // Launch with NO --backend flag — should use config file settings
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    const workerCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a.includes("worker-")),
    );
    const workerCmd = getTmuxShellCmd(workerCall!);
    expect(workerCmd).toMatch(/\bclaude\s+-p/);
    expect(workerCmd).toContain("--model claude-sonnet-4-5-20250514");
    expect(workerCmd).toContain("--permission-mode bypassPermissions");
    expect(workerCmd).toContain("--max-budget-usd 10");

    const cleanupCmd2 = mock.getCommand("harness:cleanup")!;
    await cleanupCmd2.handler("--force", ctx);
  });

  it("harness:auto --backend claude spawns scout with claude binary", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const autoCmd = mock.getCommand("harness:auto")!;
    await autoCmd.handler("--backend claude --yes Improve test coverage", ctx);

    const tmuxCalls = getTmuxNewSessionCalls(mock);
    // Auto mode spawns scout first (1 tmux session)
    expect(tmuxCalls.length).toBeGreaterThanOrEqual(1);

    const scoutCall = tmuxCalls.find((c: any) =>
      (c[1] as string[]).some((a: string) => a === "worker-scout"),
    );
    expect(scoutCall).toBeDefined();
    const scoutCmd = getTmuxShellCmd(scoutCall!);
    expect(scoutCmd).toMatch(/\bclaude\s+-p/);
    expect(scoutCmd).not.toMatch(/\bpi\s+-p/);

    // harness_status should report claude backend
    const statusTool = mock.getTool("harness_status")!;
    const result = await statusTool.execute("c1", {});
    expect(result.details.backend).toBe("claude");

    const stopCmd = mock.getCommand("harness:stop")!;
    await stopCmd.handler("", ctx);
    const cleanupCmd2 = mock.getCommand("harness:cleanup")!;
    await cleanupCmd2.handler("--force", ctx);
  });
});

// ---------------------------------------------------------------------------
// Account Rotation Integration
// ---------------------------------------------------------------------------
describe("Account rotation e2e", { timeout: 30000 }, () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "acct-rot-"));
    git("init --initial-branch=main", repo);
    git("config user.email test@test.com", repo);
    git("config user.name Test", repo);
    await writeFile(join(repo, "README.md"), "# test\n");
    git("add -A", repo);
    git("commit -m init", repo);
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  beforeEach(async () => {
    try {
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
    } catch {
      /* first test */
    }
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  function interceptSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
    const originalExec = mock.api.exec.getMockImplementation();
    mock.api.exec.mockImplementation(
      async (cmd: string, args: string[], opts?: any) => {
        if (cmd === "tmux" || cmd === "pi" || cmd === "claude") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (cmd === "ccswitch") {
          return { stdout: "Switched to account", stderr: "", exitCode: 0 };
        }
        return originalExec!(cmd, args, opts);
      },
    );
  }

  function getTmuxNewSessionCalls(
    mock: ReturnType<typeof createMockExtensionAPI>,
  ) {
    return mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );
  }

  function getCcswitchCalls(mock: ReturnType<typeof createMockExtensionAPI>) {
    return mock.api.exec.mock.calls.filter((c: any) => c[0] === "ccswitch");
  }

  it("rotates accounts round-robin across workers", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);

    // Write ccswitch sequence file
    const seqDir = join(repo, ".claude-switch-backup");
    await mkdir(seqDir, { recursive: true });
    await writeFile(
      join(seqDir, "sequence.json"),
      JSON.stringify({
        activeAccountNumber: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
        sequence: [1, 2, 3],
        accounts: {
          "1": { email: "a@test.com", uuid: "u1", added: "2025-01-01" },
          "2": { email: "b@test.com", uuid: "u2", added: "2025-01-01" },
          "3": { email: "c@test.com", uuid: "u3", added: "2025-01-01" },
        },
      }),
    );

    // Write config with account rotation enabled
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: {
          model: "claude-sonnet-4-5-20250514",
          permissionMode: "bypassPermissions",
          accountRotation: {
            enabled: true,
            strategy: "round-robin",
            ccswitchPath: "ccswitch",
            sequenceFilePath: join(
              repo,
              ".claude-switch-backup",
              "sequence.json",
            ),
          },
        },
      }),
    );

    // Create 3 goal files
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeFile(
        join(repo, PI_AGENT_DIR, `${name}.md`),
        `# ${name}\n\n## Goals\n- [ ] Do ${name}\n`,
      );
    }

    await mock.emit("session_start", {}, ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Should have called ccswitch 4 times (3 workers + 1 manager)
    const ccswitchCalls = getCcswitchCalls(mock);
    expect(ccswitchCalls.length).toBe(4);

    // Verify round-robin: accounts 1, 2, 3, 1
    const switchedTo = ccswitchCalls.map((c: any) => (c[1] as string[])[1]);
    expect(switchedTo).toEqual(["1", "2", "3", "1"]);

    // Check status shows account rotation
    const statusTool = mock.getTool("harness_status")!;
    const result = await statusTool.execute("c1", {});
    expect(result.details.accountRotation).toBe(true);
    expect(result.details.accountAssignments).toBeDefined();

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("skips rotation when disabled", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);

    // Config without account rotation
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: {
          model: "claude-sonnet-4-5-20250514",
        },
      }),
    );

    await writeFile(
      join(repo, PI_AGENT_DIR, "task.md"),
      "# task\n\n## Goals\n- [ ] Do task\n",
    );

    await mock.emit("session_start", {}, ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // No ccswitch calls
    const ccswitchCalls = getCcswitchCalls(mock);
    expect(ccswitchCalls.length).toBe(0);

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("skips rotation for pi backend", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);

    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "pi",
        claudeConfig: {
          accountRotation: {
            enabled: true,
            strategy: "round-robin",
          },
        },
      }),
    );

    await writeFile(
      join(repo, PI_AGENT_DIR, "task.md"),
      "# task\n\n## Goals\n- [ ] Do task\n",
    );

    await mock.emit("session_start", {}, ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // No ccswitch calls because backend is pi
    const ccswitchCalls = getCcswitchCalls(mock);
    expect(ccswitchCalls.length).toBe(0);

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  it("persists and restores account assignments across sessions", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);

    const seqDir = join(repo, ".claude-switch-backup");
    await mkdir(seqDir, { recursive: true });
    await writeFile(
      join(seqDir, "sequence.json"),
      JSON.stringify({
        activeAccountNumber: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
        sequence: [1, 2],
        accounts: {
          "1": { email: "a@test.com", uuid: "u1", added: "2025-01-01" },
          "2": { email: "b@test.com", uuid: "u2", added: "2025-01-01" },
        },
      }),
    );

    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: {
          accountRotation: {
            enabled: true,
            strategy: "round-robin",
            ccswitchPath: "ccswitch",
            sequenceFilePath: join(
              repo,
              ".claude-switch-backup",
              "sequence.json",
            ),
          },
        },
      }),
    );
    await writeFile(
      join(repo, PI_AGENT_DIR, "task.md"),
      "# task\n\n## Goals\n- [ ] Do task\n",
    );

    await mock.emit("session_start", {}, ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // Verify state file includes accountAssignments
    const stateContent = await readFile(
      join(repo, ".pi-agent/.launch-state.json"),
      "utf-8",
    );
    const state = JSON.parse(stateContent);
    expect(state.accountAssignments).toBeDefined();
    expect(Object.keys(state.accountAssignments).length).toBeGreaterThan(0);

    // Restore in a fresh instance
    const { mock: mock2, ctx: ctx2 } = freshHarness();
    interceptSpawns(mock2);
    await mock2.emit("session_start", {}, ctx2);

    // Status should still reflect account rotation
    const statusTool = mock2.getTool("harness_status")!;
    const result = await statusTool.execute("c1", {});
    expect(result.details.accountRotation).toBe(true);

    const cleanupCmd = mock2.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx2);
  });

  it("usage threshold skips over-budget accounts", async () => {
    const { mock, ctx } = freshHarness();
    interceptSpawns(mock);

    const seqDir = join(repo, ".claude-switch-backup");
    await mkdir(seqDir, { recursive: true });
    await writeFile(
      join(seqDir, "sequence.json"),
      JSON.stringify({
        activeAccountNumber: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
        sequence: [1, 2],
        accounts: {
          "1": { email: "a@test.com", uuid: "u1", added: "2025-01-01" },
          "2": { email: "b@test.com", uuid: "u2", added: "2025-01-01" },
        },
      }),
    );

    // Pre-populate usage tracking with account 1 over threshold
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    const usageStore: UsageTrackingStore = {
      version: 1,
      accounts: [
        {
          accountNumber: 1,
          email: "a@test.com",
          totalCostUsd: 100,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          sessionCount: 10,
          lastUsedAt: "2025-01-01",
          sessions: [],
        },
      ],
      updatedAt: "2025-01-01",
    };
    await writeFile(
      join(repo, USAGE_TRACKING_FILE),
      JSON.stringify(usageStore),
    );

    await writeFile(
      join(repo, HARNESS_CONFIG_FILE),
      JSON.stringify({
        backend: "claude",
        claudeConfig: {
          accountRotation: {
            enabled: true,
            strategy: "round-robin",
            usageThresholdUsd: 50.0,
            ccswitchPath: "ccswitch",
            sequenceFilePath: join(
              repo,
              ".claude-switch-backup",
              "sequence.json",
            ),
          },
        },
      }),
    );

    await writeFile(
      join(repo, PI_AGENT_DIR, "task.md"),
      "# task\n\n## Goals\n- [ ] Do task\n",
    );

    await mock.emit("session_start", {}, ctx);
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("", ctx);

    // All ccswitch calls should be to account 2 (account 1 is over threshold)
    const ccswitchCalls = getCcswitchCalls(mock);
    expect(ccswitchCalls.length).toBeGreaterThan(0);
    for (const call of ccswitchCalls) {
      expect((call[1] as string[])[1]).toBe("2");
    }

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });
});
