/**
 * Sophisticated BMAD + Harness E2E Test — Part 4: --init Flag & Edge Cases
 *
 * This test suite focuses on the new `--init` flag for `/harness:bmad` and
 * exercises the "1-step BMAD path" that was just implemented:
 *
 *   /harness:bmad --init              (auto-detect everything, default level 2)
 *   /harness:bmad --init --level 0    (explicit level override)
 *   /harness:bmad --init --level 4    (enterprise-scale project)
 *
 * It also covers untested edge cases:
 *   - --init on a repo with existing config (should skip scaffold, use existing)
 *   - --init auto-detection from package.json / pyproject.toml / go.mod / Cargo.toml
 *   - --init combined with --max-workers
 *   - --init on a bare repo (no manifest files — falls back to dirname)
 *   - harness:bmad running twice (already active guard)
 *   - harness:stop then harness:bmad restart cycle
 *   - BMAD mode file correctness after --init
 *   - Template expansion correctness (no mustache placeholders left)
 *   - Worktree branch naming for BMAD workers
 *   - Goal file content from --init matches template system
 *   - Queue ordering respects dependency DAG from --init
 *   - Multiple --init calls are idempotent (second is no-op)
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
  Text: class { constructor(public text: string, public x: number, public y: number) {} },
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
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  MAILBOX_DIR,
  REGISTRY_FILE,
  BMAD_PREFIX,
  readRegistry,
  readQueue,
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
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function createMockExtensionAPI() {
  const handlers = new Map<string, Function[]>();
  const tools: Array<{ name: string; [k: string]: any }> = [];
  const commands = new Map<string, { description: string; handler: Function }>();

  const api = {
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool(def: any) { tools.push(def); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn().mockImplementation(async (cmd: string, args: string[], opts?: any) => {
      const cwd = opts?.cwd || ".";
      try {
        const quotedArgs = args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`);
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
      for (const fn of handlers.get(event) ?? []) await fn(eventData, ctx);
    },
    getCommand(name: string) { return commands.get(name); },
    getTool(name: string) { return tools.find((t) => t.name === name); },
  };
}

function createMockContext(cwd: string) {
  return {
    cwd,
    isIdle: vi.fn().mockReturnValue(true),
    getContextUsage: vi.fn().mockReturnValue({ tokens: 5000, contextWindow: 100_000, percent: 5 }),
    newSession: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

function interceptPiSpawns(mock: ReturnType<typeof createMockExtensionAPI>) {
  const originalExec = mock.api.exec.getMockImplementation();
  mock.api.exec.mockImplementation(async (cmd: string, args: string[], opts?: any) => {
    if (cmd === "pi" || cmd === "tmux") return { stdout: "", stderr: "", exitCode: 0 };
    return originalExec!(cmd, args, opts);
  });
}

async function cleanupHarnessState(repo: string) {
  try {
    const wtDir = join(repo, WORKTREE_DIR);
    try {
      for (const entry of await readdir(wtDir)) {
        try { git(`worktree remove ${join(wtDir, entry)} --force`, repo); } catch { /* */ }
      }
    } catch { /* */ }
    try { git("worktree prune", repo); } catch { /* */ }
    try {
      for (const b of git("branch --list pi-agent/*", repo).split("\n")) {
        const branch = b.trim();
        if (branch) try { git(`branch -D ${branch}`, repo); } catch { /* */ }
      }
    } catch { /* */ }
    await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
  } catch { /* first test */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe("BMAD harness e2e part 4: --init flag and 1-step BMAD path", { timeout: 60000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bmad-e2e4-"));
    repo = join(baseDir, "my-cool-project");
    git(`init ${repo}`, baseDir);
    git('config user.email "zach@test.dev"', repo);
    git('config user.name "Zach"', repo);
    // Create a package.json for auto-detection
    await writeFile(join(repo, "package.json"), JSON.stringify({
      name: "my-cool-project",
      version: "1.0.0",
      description: "A cool project",
    }, null, 2));
    await writeFile(join(repo, "index.ts"), 'console.log("hello");\n');
    git("add -A", repo);
    git('commit -m "initial commit"', repo);
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null", { encoding: "utf-8" }); } catch { /* */ }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanupHarnessState(repo);
    // Clean up bmad files between tests
    await rm(join(repo, "bmad"), { recursive: true, force: true }).catch(() => {});
    await rm(join(repo, "docs"), { recursive: true, force: true }).catch(() => {});
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Test 1: --init on bare repo auto-detects from package.json
  // ═════════════════════════════════════════════════════════════════════════
  it("--init auto-detects project name from package.json and scaffolds config+status", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // 1-step BMAD: no prior config, no /bmad-init, just --init
    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 2", ctx);

    // No errors
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Should have notified about BMAD init
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("my-cool-project"),
      "info",
    );

    // Config file should exist and have detected name
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("my-cool-project");
    expect(config).toContain("web-app"); // auto-detected from package.json
    expect(config).toContain("project_level: 2"); // default level

    // Status file should exist
    const status = await readFile(join(repo, "docs", "bmm-workflow-status.yaml"), "utf-8");
    expect(status).toContain("workflow_status:");
    expect(status).toContain("product-brief"); // L2 includes all workflows
    expect(status).toContain("architecture");

    // Template variables should be fully expanded (no leftover {{...}})
    expect(config).not.toMatch(/\{\{.*?\}\}/);
    expect(status).not.toMatch(/\{\{.*?\}\}/);

    // Harness should be fully launched
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);

    // Should have BMAD mode file
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.projectName).toBe("my-cool-project");
    expect(bmadMode.projectLevel).toBe(2);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 2: --init with explicit --level 0 creates minimal DAG
  // ═════════════════════════════════════════════════════════════════════════
  it("--init --level 0 creates L0 minimal project with 4 workflows", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 0 --max-workers 1", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Config should show level 0
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("project_level: 0");

    // BMAD mode should have exactly 4 workflows for L0
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.workflows.length).toBe(4);
    const wfNames = bmadMode.workflows.map((w: any) => w.workflowName).sort();
    expect(wfNames).toEqual(["create-story", "dev-story", "sprint-planning", "tech-spec"]);

    // Only tech-spec should be active (entry point for L0)
    const active = bmadMode.workflows.filter((w: any) => w.status === "active");
    expect(active.length).toBe(1);
    expect(active[0].workflowName).toBe("tech-spec");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 3: --init when config already exists → skip scaffold, use existing
  // ═════════════════════════════════════════════════════════════════════════
  it("--init with existing config skips scaffold and uses existing config", async () => {
    // Pre-create a custom config
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        'project_name: "PreExistingProject"',
        "project_type: api",
        "project_level: 1",
        "user_name: zach",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      ].join("\n"),
    );
    git("add -A && git commit -m 'pre-existing config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Should notify that scaffold was skipped
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "info",
    );

    // Config should NOT have been overwritten
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("PreExistingProject");
    expect(config).not.toContain("my-cool-project");

    // Should still launch successfully (L1, no status file → all incomplete)
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);

    // BMAD mode should use the pre-existing config's level
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.projectLevel).toBe(1);
    expect(bmadMode.projectName).toBe("PreExistingProject");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 4: --init auto-detects Python project from pyproject.toml
  // ═════════════════════════════════════════════════════════════════════════
  it("--init auto-detects Python project name and type from pyproject.toml", async () => {
    // Temporarily swap manifest files
    const pkgBackup = await readFile(join(repo, "package.json"), "utf-8");
    await rm(join(repo, "package.json"));
    await writeFile(
      join(repo, "pyproject.toml"),
      [
        '[project]',
        'name = "my-python-api"',
        'version = "0.1.0"',
        'description = "A Python API"',
      ].join("\n"),
    );
    git("add -A && git commit -m 'python project'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Config should have Python-detected values
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("my-python-api");
    expect(config).toContain("api"); // auto-detected type for pyproject.toml

    // Restore package.json for subsequent tests
    await rm(join(repo, "pyproject.toml"));
    await writeFile(join(repo, "package.json"), pkgBackup);
    await rm(join(repo, "bmad"), { recursive: true, force: true });
    await rm(join(repo, "docs"), { recursive: true, force: true });
    git("add -A && git commit -m 'restore package.json'", repo);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 5: --init with no manifest files falls back to dirname
  // ═════════════════════════════════════════════════════════════════════════
  it("--init with no manifest files falls back to directory name", async () => {
    // Create a second repo with no manifest files
    const bareRepo = join(baseDir, "bare-project");
    git(`init ${bareRepo}`, baseDir);
    git('config user.email "zach@test.dev"', bareRepo);
    git('config user.name "Zach"', bareRepo);
    await writeFile(join(bareRepo, "main.c"), '#include <stdio.h>\nint main() { return 0; }\n');
    git("add -A", bareRepo);
    git('commit -m "initial"', bareRepo);

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(bareRepo);
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Config should use directory name as project name
    const config = await readFile(join(bareRepo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("bare-project");
    // Type should default to web-app when nothing is detected
    expect(config).toContain("web-app");

    // Clean up
    await rm(bareRepo, { recursive: true, force: true });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 6: Double --init is idempotent (second call skips, uses existing)
  // ═════════════════════════════════════════════════════════════════════════
  it("double --init is idempotent: second call skips scaffold and uses first config", async () => {
    // First run: --init creates everything
    const { mock: mock1, ctx: ctx1 } = freshHarness();
    interceptPiSpawns(mock1);
    await mock1.emit("session_start", {}, ctx1);
    await mock1.getCommand("harness:bmad")!.handler("--init --level 1 --max-workers 1", ctx1);

    const config1 = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config1).toContain("project_level: 1");

    // Stop the harness
    await mock1.getCommand("harness:stop")!.handler("", ctx1);

    // Clean up worktrees/state but leave bmad config
    await cleanupHarnessState(repo);

    // Second run: --init with different level should skip scaffold
    const { mock: mock2, ctx: ctx2 } = freshHarness();
    interceptPiSpawns(mock2);
    await mock2.emit("session_start", {}, ctx2);
    await mock2.getCommand("harness:bmad")!.handler("--init --level 3 --max-workers 1", ctx2);

    // Config should NOT have been overwritten (still level 1)
    const config2 = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config2).toContain("project_level: 1");
    expect(config2).not.toContain("project_level: 3");

    // Should have notified about skipping
    expect(ctx2.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "info",
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 7: --init config file is a valid BMAD template expansion
  // ═════════════════════════════════════════════════════════════════════════
  it("--init produces valid BMAD config that loadBmadConfig can parse", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Parse the config manually to verify structure
    const configContent = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");

    // Should have all required fields
    expect(configContent).toContain("project_name:");
    expect(configContent).toContain("project_type:");
    expect(configContent).toContain("project_level:");
    expect(configContent).toContain("output_folder:");
    expect(configContent).toContain("bmm:");
    expect(configContent).toContain("workflow_status_file:");
    expect(configContent).toContain("paths:");
    expect(configContent).toContain("docs:");
    expect(configContent).toContain("stories:");
    expect(configContent).toContain("tests:");

    // Status file should have proper structure
    const statusContent = await readFile(join(repo, "docs", "bmm-workflow-status.yaml"), "utf-8");
    expect(statusContent).toContain("workflow_status:");
    expect(statusContent).toContain("- name:");
    expect(statusContent).toContain("phase:");
    expect(statusContent).toContain("status:");
    expect(statusContent).toContain("description:");

    // No unexpanded template variables
    expect(configContent).not.toMatch(/\{\{.*?\}\}/);
    expect(statusContent).not.toMatch(/\{\{.*?\}\}/);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 8: --init L2 DAG has correct dependency structure
  // ═════════════════════════════════════════════════════════════════════════
  it("--init L2 project has full dependency DAG with correct phase ordering", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 2", ctx);

    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );

    // L2 should include Phase 1, 2, 3, 4 workflows
    const wfNames = bmadMode.workflows.map((w: any) => w.workflowName);
    expect(wfNames).toContain("product-brief");
    expect(wfNames).toContain("prd");
    expect(wfNames).toContain("architecture");
    expect(wfNames).toContain("sprint-planning");
    expect(wfNames).toContain("create-story");
    expect(wfNames).toContain("dev-story");

    // Phase 1 workflows should have no deps → active
    const productBrief = bmadMode.workflows.find((w: any) => w.workflowName === "product-brief");
    expect(productBrief.dependsOn).toEqual([]);
    expect(productBrief.phase).toBe(1);

    // Phase 2 prd depends on product-brief
    const prd = bmadMode.workflows.find((w: any) => w.workflowName === "prd");
    expect(prd.dependsOn).toContain(`${BMAD_PREFIX}product-brief`);

    // Phase 3 architecture depends on prd + tech-spec
    const arch = bmadMode.workflows.find((w: any) => w.workflowName === "architecture");
    expect(arch.dependsOn).toContain(`${BMAD_PREFIX}prd`);

    // Phase 4 sprint-planning depends on architecture
    const sprint = bmadMode.workflows.find((w: any) => w.workflowName === "sprint-planning");
    expect(sprint.dependsOn).toContain(`${BMAD_PREFIX}architecture`);

    // Queue should contain blocked workflows
    const queue = await readQueue(repo);
    const queueNames = queue.items.map((i: any) => i.name);

    // Blocked items should be in queue (at least some Phase 2+ workflows)
    expect(queue.items.length).toBeGreaterThan(0);

    // Active items should NOT be in queue
    const activeWfs = bmadMode.workflows.filter((w: any) => w.status === "active");
    for (const active of activeWfs) {
      expect(queueNames).not.toContain(active.name);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 9: Worktree branches have correct BMAD naming convention
  // ═════════════════════════════════════════════════════════════════════════
  it("--init spawns worktrees with pi-agent/bmad-* branch naming", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 0 --max-workers 4", ctx);

    // L0 only has tech-spec as the entry point (others are deps)
    // Check that the worktree was created with correct branch
    const branches = git("branch --list pi-agent/*", repo).split("\n").map(b => b.trim());
    const bmadBranches = branches.filter(b => b.includes("bmad-"));
    expect(bmadBranches.length).toBeGreaterThan(0);

    // Branch should follow pi-agent/bmad-<workflow> convention
    expect(bmadBranches.some(b => b.includes("bmad-tech-spec"))).toBe(true);

    // Worktree directory should exist
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    expect(worktrees.some(w => w.includes("bmad-tech-spec"))).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 10: Goal files from --init match worker prompt expectations
  // ═════════════════════════════════════════════════════════════════════════
  it("--init generates goal files with correct role, goals, and BMAD context", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 0 --max-workers 1", ctx);

    // Read the tech-spec goal file (only active worker at L0)
    const goalFile = await readFile(
      join(repo, PI_AGENT_DIR, "bmad-tech-spec.md"),
      "utf-8",
    );

    // Should have the worker name as header
    expect(goalFile).toContain("bmad-tech-spec");

    // Should have a role
    expect(goalFile).toContain("role:");

    // Should have goals section with unchecked items
    expect(goalFile).toContain("## Goals");
    expect(goalFile).toContain("- [ ]");

    // Should have BMAD context
    expect(goalFile).toContain("BMAD workflow: tech-spec");

    // Prompt file should also exist
    const promptPath = join(repo, PI_AGENT_DIR, ".prompts", "bmad-tech-spec.md");
    const prompt = await readFile(promptPath, "utf-8");
    expect(prompt.length).toBeGreaterThan(100); // should be a substantial prompt
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 11: harness:bmad guards against double launch
  // ═════════════════════════════════════════════════════════════════════════
  it("second /harness:bmad while active warns user to stop first", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // First launch
    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Try second launch
    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 2", ctx);

    // Should warn about active harness
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already active"),
      "warning",
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 12: stop → restart cycle works cleanly with --init
  // ═════════════════════════════════════════════════════════════════════════
  it("harness:stop then harness:bmad restart works cleanly", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Launch
    await mock.getCommand("harness:bmad")!.handler("--init --level 1 --max-workers 1", ctx);
    let state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);

    // Stop
    await mock.getCommand("harness:stop")!.handler("", ctx);

    // Restart (no --init since config already exists)
    // Need fresh harness instance since state is in-memory
    await cleanupHarnessState(repo);

    const { mock: mock2, ctx: ctx2 } = freshHarness();
    interceptPiSpawns(mock2);
    await mock2.emit("session_start", {}, ctx2);
    await mock2.getCommand("harness:bmad")!.handler("--max-workers 1", ctx2);

    // Should launch again without errors
    const errorCalls = ctx2.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    state = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 13: --init error message quality — mentions both /bmad-init and --init
  // ═════════════════════════════════════════════════════════════════════════
  it("error message without --init mentions both /bmad-init and /harness:bmad --init", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // No --init, no config → should error
    await mock.getCommand("harness:bmad")!.handler("", ctx);

    // Error should mention both paths
    const errorCall = ctx.ui.notify.mock.calls.find((c: any[]) => c[1] === "error");
    expect(errorCall).toBeDefined();
    const errorMsg = errorCall![0] as string;
    expect(errorMsg).toContain("/bmad-init");
    expect(errorMsg).toContain("--init");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 14: --init status file has level-appropriate default statuses
  // ═════════════════════════════════════════════════════════════════════════
  it("--init status file reflects level-appropriate default statuses", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 1", ctx);

    const status = await readFile(join(repo, "docs", "bmm-workflow-status.yaml"), "utf-8");

    // At L2: prd should be "required", architecture should be "required"
    // tech-spec should be "optional" at L2
    // product-brief should be "optional"
    // These match WORKFLOW_DEFS.defaultStatus(2) calls:
    // prd: l >= 2 ? "required" : "recommended" → "required"
    // tech-spec: l <= 1 ? "required" : "optional" → "optional"
    // architecture: l >= 2 ? "required" : "optional" → "required"

    // Extract status for specific workflows
    const prdMatch = status.match(/name:\s*prd[\s\S]*?status:\s*"([^"]+)"/);
    expect(prdMatch?.[1]).toBe("required");

    const techSpecMatch = status.match(/name:\s*tech-spec[\s\S]*?status:\s*"([^"]+)"/);
    expect(techSpecMatch?.[1]).toBe("optional");

    const archMatch = status.match(/name:\s*architecture[\s\S]*?status:\s*"([^"]+)"/);
    expect(archMatch?.[1]).toBe("required");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 15: --init creates mailboxes for all spawned workers
  // ═════════════════════════════════════════════════════════════════════════
  it("--init creates mailbox directories for all launched workers", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 3", ctx);

    // Get the registry to know which workers were spawned
    const registry = await readRegistry(repo);
    const workerNames = Object.keys(registry.workers);
    expect(workerNames.length).toBeGreaterThan(0);

    // Each spawned worker should have a mailbox directory
    for (const name of workerNames) {
      let mailboxExists = false;
      try {
        await stat(join(repo, MAILBOX_DIR, name));
        mailboxExists = true;
      } catch { /* */ }
      expect(mailboxExists).toBe(true);
    }

    // Parent and manager mailboxes should also exist
    let parentMailbox = false;
    try { await stat(join(repo, MAILBOX_DIR, "parent")); parentMailbox = true; } catch { /* */ }
    expect(parentMailbox).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 16: Step count comparison — --init is truly 1-step
  // ═════════════════════════════════════════════════════════════════════════
  it("documents that --init reduces BMAD path from 2 steps to 1 step", async () => {
    // BEFORE (2-step BMAD path):
    //   Step 1: /bmad-init (interactive, or manually write config+status)
    //   Step 2: /harness:bmad
    //
    // AFTER (1-step BMAD path):
    //   Step 1: /harness:bmad --init
    //
    // Verify the 1-step path works end-to-end:
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // ONE COMMAND: creates config, status, goal files, worktrees, manager
    await mock.getCommand("harness:bmad")!.handler("--init", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Everything should be running
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);
    expect(Object.keys(launchState.sessions).length).toBeGreaterThan(0);

    // All required files should exist
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.enabled).toBe(true);
    expect(bmadMode.workflows.length).toBeGreaterThan(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 17: --init with --max-workers limits concurrent spawns correctly
  // ═════════════════════════════════════════════════════════════════════════
  it("--init respects --max-workers limit for concurrent spawns", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // L2 has many ready workflows (product-brief, brainstorm, research)
    // With max-workers 1, only 1 should be spawned
    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 1", ctx);

    const registry = await readRegistry(repo);
    const workerNames = Object.keys(registry.workers);
    expect(workerNames.length).toBe(1);

    // The rest should be queued
    const queue = await readQueue(repo);
    expect(queue.items.length).toBeGreaterThan(0);
  });
});
