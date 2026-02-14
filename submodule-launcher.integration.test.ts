/**
 * Integration tests for submodule-launcher against a real git repo.
 *
 * These tests create temporary git repos with submodules and exercise
 * the extension end-to-end, including actual git operations.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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
  type SubmoduleConfig,
  type LaunchState,
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
