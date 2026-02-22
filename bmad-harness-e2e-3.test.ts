/**
 * Sophisticated BMAD + Harness E2E Test — Part 3: Cold Start UX
 *
 * This test suite focuses on the question: "I'm just kicking this off,
 * how can I reduce the number of steps and set up the repo in 1-2 steps?"
 *
 * It exercises every "zero to running" path:
 *   1. Cold start: git repo → /harness:bmad (no prior setup)
 *   2. Config-only: bmad/config.yaml exists but no status file
 *   3. Status-only: status file exists but no config
 *   4. Full path: config + status → /harness:bmad (2-step ideal)
 *   5. Programmatic BMAD init: can we bypass interactive /bmad-init?
 *   6. /harness:auto as single-step alternative
 *   7. /harness:init → /harness:add → /harness:launch (manual path)
 *   8. Redundant init: double /harness:init is idempotent
 *   9. Error message quality: are messages actionable?
 *  10. What auto-scaffolding does each command perform?
 *  11. Edge: config references non-existent status file path
 *  12. Edge: status file exists but is empty YAML
 *  13. Edge: all workflows pre-completed → graceful no-op
 *  14. Can /harness:bmad work if we just write config + status directly? (skip /bmad-init entirely)
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

// ---------------------------------------------------------------------------
// Minimal project scaffolding — the bare minimum a user would have
// ---------------------------------------------------------------------------

async function scaffoldBareProject(dir: string): Promise<void> {
  await writeFile(join(dir, "README.md"), "# My Project\nA new project.\n");
  await writeFile(join(dir, "main.py"), 'print("hello")\n');
}

/**
 * Write BMAD config + status in one shot — the "programmatic /bmad-init".
 * This is what a user SHOULD be able to do instead of running interactive /bmad-init.
 */
async function programmaticBmadInit(
  dir: string,
  name: string,
  level: number,
  type = "web-app",
): Promise<void> {
  // Step 1: config
  await mkdir(join(dir, "bmad"), { recursive: true });
  await writeFile(
    join(dir, "bmad", "config.yaml"),
    [
      "version: '6.0.0'",
      `project_name: "${name}"`,
      `project_type: ${type}`,
      `project_level: ${level}`,
      "user_name: zach",
      "output_folder: docs",
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

  // Step 2: status file with default statuses for the level
  await mkdir(join(dir, "docs"), { recursive: true });
  const { WORKFLOW_DEFS } = await import("./bmad.js");

  // Determine which workflows are included at this level
  const included = new Set<string>();
  // Level 0: tech-spec → sprint-planning → create-story → dev-story
  if (level >= 0) {
    included.add("tech-spec");
    included.add("sprint-planning");
    included.add("create-story");
    included.add("dev-story");
  }
  if (level >= 1) {
    included.add("product-brief");
    included.add("brainstorm");
    included.add("research");
  }
  if (level >= 2) {
    included.add("prd");
    included.add("create-ux-design");
    included.add("architecture");
    included.add("solutioning-gate-check");
  }

  const lines = ["# BMAD Workflow Status", "", "workflow_status:"];
  for (const wf of WORKFLOW_DEFS) {
    if (!included.has(wf.name)) continue;
    const status = wf.defaultStatus(level);
    lines.push(
      `  - name: ${wf.name}`,
      `    phase: ${wf.phase}`,
      `    status: "${status}"`,
      `    description: "${wf.description}"`,
      "",
    );
  }
  await writeFile(join(dir, "docs", "bmm-workflow-status.yaml"), lines.join("\n"));
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

describe("BMAD harness e2e part 3: cold start UX and minimal-step onboarding", { timeout: 60000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bmad-e2e3-"));
    repo = join(baseDir, "my-project");
    git(`init ${repo}`, baseDir);
    git('config user.email "zach@test.dev"', repo);
    git('config user.name "Zach"', repo);
    await scaffoldBareProject(repo);
    git("add -A", repo);
    git('commit -m "initial commit"', repo);
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null", { encoding: "utf-8" }); } catch { /* */ }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanupHarnessState(repo);
    // Also clean up bmad files between tests
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
  // Test 1: Absolute cold start — /harness:bmad on a bare repo with nothing
  // ═════════════════════════════════════════════════════════════════════════
  it("cold start: /harness:bmad on bare repo gives clear error pointing to /bmad-init", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // No bmad config, no status file, no .pi-agent/ — just a bare git repo
    await mock.getCommand("harness:bmad")!.handler("", ctx);

    // Should get an actionable error
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No BMAD configuration found"),
      "error",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("/bmad-init"),
      "error",
    );

    // FIX VERIFIED: .pi-agent/ should NOT exist on bare repos.
    // session_start now only creates mailboxes when loopActive is true.
    let piAgentExists = true;
    try {
      await stat(join(repo, PI_AGENT_DIR));
    } catch {
      piAgentExists = false;
    }
    expect(piAgentExists).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 2: The golden path — programmatic config+status → /harness:bmad
  //         This is the "2-step" ideal: write files + run command
  // ═════════════════════════════════════════════════════════════════════════
  it("2-step ideal: programmatic bmad init + /harness:bmad launches workers immediately", async () => {
    // Step 1: Write config + status programmatically (replaces interactive /bmad-init)
    await programmaticBmadInit(repo, "MyProject", 2);
    git("add -A && git commit -m 'add bmad config'", repo);

    // Step 2: Launch harness
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 3", ctx);

    // Should have launched successfully — no errors
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // .pi-agent/ should be auto-created (no /harness:init needed)
    const piAgentFiles = await readdir(join(repo, PI_AGENT_DIR));
    expect(piAgentFiles.length).toBeGreaterThan(0);

    // Goal files should exist for phase-1 workflows
    const goalFiles = piAgentFiles.filter(f => f.endsWith(".md") && !f.startsWith("."));
    expect(goalFiles.length).toBeGreaterThan(0);

    // Worktrees should be created for ready workflows
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    expect(worktrees.length).toBeGreaterThan(0);

    // Prompts directory should be created
    expect(piAgentFiles).toContain(".prompts");

    // .bmad-mode.json should exist
    expect(piAgentFiles).toContain(".bmad-mode.json");

    // Launch state should be active
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);

    // Mailboxes should be created
    let mailboxExists = false;
    try { await stat(join(repo, MAILBOX_DIR)); mailboxExists = true; } catch { /* */ }
    expect(mailboxExists).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 3: Config exists but NO status file — should work (fresh project)
  // ═════════════════════════════════════════════════════════════════════════
  it("config only (no status file): /harness:bmad treats all workflows as incomplete and launches", async () => {
    // Only write config, skip status file
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        'project_name: "FreshProject"',
        "project_type: api",
        "project_level: 1",
        "user_name: zach",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      ].join("\n"),
    );
    git("add -A && git commit -m 'config only'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 2", ctx);

    // Should NOT error — missing status file is expected for fresh projects
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Should NOT warn about malformed (file simply doesn't exist)
    const warningCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "warning");
    const malformedWarning = warningCalls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("malformed"),
    );
    expect(malformedWarning).toBeUndefined();

    // All L1 workflows should be in the DAG (nothing is completed)
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    const wfNames = bmadMode.workflows.map((w: any) => w.workflowName);
    expect(wfNames).toContain("product-brief");
    expect(wfNames).toContain("brainstorm");
    expect(wfNames).toContain("tech-spec");
    expect(wfNames).toContain("sprint-planning");

    // Phase 1 (no deps) should be active, the rest pending
    const active = bmadMode.workflows.filter((w: any) => w.status === "active");
    const pending = bmadMode.workflows.filter((w: any) => w.status === "pending");
    expect(active.length).toBeGreaterThan(0);
    expect(pending.length).toBeGreaterThan(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 4: Status file exists but is empty YAML — should warn
  // ═════════════════════════════════════════════════════════════════════════
  it("empty status file triggers malformed warning but still launches", async () => {
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        'project_name: "EmptyStatus"',
        "project_type: api",
        "project_level: 0",
        "user_name: zach",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      ].join("\n"),
    );
    // Write an empty status file
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "bmm-workflow-status.yaml"), "# Empty\n");
    git("add -A && git commit -m 'empty status'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Should warn about malformed status (file exists but 0 entries)
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("malformed"),
      "warning",
    );

    // Should still launch (all workflows treated as incomplete)
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 5: All workflows pre-completed → graceful no-op
  // ═════════════════════════════════════════════════════════════════════════
  it("all workflows complete: /harness:bmad says 'already complete' and does nothing", async () => {
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        'project_name: "DoneProject"',
        "project_type: api",
        "project_level: 0",
        "user_name: zach",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      ].join("\n"),
    );
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(
      join(repo, "docs", "bmm-workflow-status.yaml"),
      [
        "workflow_status:",
        "  - name: tech-spec",
        "    phase: 2",
        '    status: "docs/tech-spec.md"',
        "  - name: sprint-planning",
        "    phase: 4",
        '    status: "docs/sprint.md"',
        "  - name: create-story",
        "    phase: 4",
        '    status: "docs/story.md"',
        "  - name: dev-story",
        "    phase: 4",
        '    status: "docs/dev.md"',
      ].join("\n"),
    );
    git("add -A && git commit -m 'all complete'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("", ctx);

    // Should notify completion
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already complete"),
      "info",
    );

    // FIX VERIFIED: .pi-agent/ should NOT exist since harness was never activated.
    let piAgentExists = true;
    try {
      await stat(join(repo, PI_AGENT_DIR));
    } catch {
      piAgentExists = false;
    }
    expect(piAgentExists).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 6: /harness:auto as the true 1-step path (no BMAD prereqs)
  // ═════════════════════════════════════════════════════════════════════════
  it("1-step path: /harness:auto works on a completely bare repo with zero prerequisites", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Run auto mode on a bare repo — no config, no status, no .pi-agent/
    await mock.getCommand("harness:auto")!.handler("improve code quality", ctx);

    // Should NOT error
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // .pi-agent/ should be auto-created
    const piAgentFiles = await readdir(join(repo, PI_AGENT_DIR));
    expect(piAgentFiles.length).toBeGreaterThan(0);

    // Auto mode state file should exist
    expect(piAgentFiles).toContain(".auto-mode.json");

    // Scout goal file should exist
    const goalFiles = piAgentFiles.filter(f => f.endsWith(".md") && !f.startsWith("."));
    expect(goalFiles).toContain("scout.md");

    // Scout goal should have correct content
    const scoutGoal = await readFile(join(repo, PI_AGENT_DIR, "scout.md"), "utf-8");
    expect(scoutGoal).toContain("scout");

    // Mailboxes should be created
    let mailboxExists = false;
    try { await stat(join(repo, MAILBOX_DIR, "parent")); mailboxExists = true; } catch { /* */ }
    expect(mailboxExists).toBe(true);

    // Auto mode config should capture the objective
    const autoMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".auto-mode.json"), "utf-8"),
    );
    expect(autoMode.enabled).toBe(true);
    expect(autoMode.config.objective).toContain("improve code quality");
    expect(autoMode.phase).toBe("scouting");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 7: Manual path — /harness:init → /harness:add → /harness:launch
  // ═════════════════════════════════════════════════════════════════════════
  it("manual 3-step path: init → add → launch works without any BMAD config", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Step 1: Init
    await mock.getCommand("harness:init")!.handler("", ctx);
    let piAgentExists = false;
    try { await stat(join(repo, PI_AGENT_DIR)); piAgentExists = true; } catch { /* */ }
    expect(piAgentExists).toBe(true);

    // Step 2: Add a task
    await mock.getCommand("harness:add")!.handler(
      "fix-auth Fix hardcoded JWT secret, Add token refresh, Write auth tests",
      ctx,
    );
    const goalPath = join(repo, PI_AGENT_DIR, "fix-auth.md");
    const goalContent = await readFile(goalPath, "utf-8");
    expect(goalContent).toContain("Fix hardcoded JWT secret");
    expect(goalContent).toContain("Add token refresh");
    expect(goalContent).toContain("Write auth tests");

    // Step 3: Launch
    await mock.getCommand("harness:launch")!.handler("--max-workers 1", ctx);

    // Should be active
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.sessions["fix-auth"]).toBeDefined();

    // Worktree should exist
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    expect(worktrees).toContain("fix-auth");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 8: /harness:init is idempotent
  // ═════════════════════════════════════════════════════════════════════════
  it("double /harness:init is idempotent — preserves existing goal files", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Init once
    await mock.getCommand("harness:init")!.handler("", ctx);

    // Add a task
    await mock.getCommand("harness:add")!.handler("my-task Do something", ctx);

    // Init again
    await mock.getCommand("harness:init")!.handler("", ctx);

    // Goal file should still exist
    const goalPath = join(repo, PI_AGENT_DIR, "my-task.md");
    const content = await readFile(goalPath, "utf-8");
    expect(content).toContain("Do something");

    // Should report the existing task
    const initMsg = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-init",
    );
    const lastInit = initMsg[initMsg.length - 1];
    expect(lastInit[0].content).toContain("my-task");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 9: /harness:launch with no goal files → helpful error
  // ═════════════════════════════════════════════════════════════════════════
  it("launch with no goal files gives helpful error mentioning /harness:init", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Try to launch without any setup
    await mock.getCommand("harness:launch")!.handler("", ctx);

    // Should get helpful error
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No goal files"),
      "warning",
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 10: /harness:bmad auto-creates .pi-agent/ (no /harness:init needed)
  // ═════════════════════════════════════════════════════════════════════════
  it("/harness:bmad auto-creates .pi-agent/ directory without prior /harness:init", async () => {
    await programmaticBmadInit(repo, "AutoScaffold", 0);
    git("add -A && git commit -m 'auto scaffold test'", repo);

    // Verify .pi-agent/ does NOT exist before running
    let piAgentBefore = false;
    try { await stat(join(repo, PI_AGENT_DIR)); piAgentBefore = true; } catch { /* */ }
    expect(piAgentBefore).toBe(false);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // .pi-agent/ should now exist with full structure
    const piAgentFiles = await readdir(join(repo, PI_AGENT_DIR));
    expect(piAgentFiles.length).toBeGreaterThan(0);

    // Should have goal files, prompts, bmad-mode, etc.
    const goalFiles = piAgentFiles.filter(f => f.endsWith(".md") && !f.startsWith("."));
    expect(goalFiles.length).toBeGreaterThan(0);
    expect(piAgentFiles).toContain(".prompts");
    expect(piAgentFiles).toContain(".bmad-mode.json");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 11: Config references wrong status file path — no crash
  // ═════════════════════════════════════════════════════════════════════════
  it("config with wrong status file path gracefully treats workflows as incomplete", async () => {
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(
      join(repo, "bmad", "config.yaml"),
      [
        "version: '6.0.0'",
        'project_name: "BadPath"',
        "project_type: api",
        "project_level: 0",
        "user_name: zach",
        "output_folder: docs",
        "",
        "bmm:",
        '  workflow_status_file: "nonexistent/wrong-path.yaml"',
      ].join("\n"),
    );
    git("add -A && git commit -m 'bad path config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Should NOT crash — the missing file is handled gracefully
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Should launch with all workflows as incomplete
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 12: The "2-step comparison" — measure what each path auto-creates
  // ═════════════════════════════════════════════════════════════════════════
  it("2-step BMAD path creates complete scaffolding: goal files, prompts, mailboxes, mode, registry, queue, state", async () => {
    // The 2-step path: (1) write config+status, (2) /harness:bmad
    await programmaticBmadInit(repo, "FullScaffold", 1);
    git("add -A && git commit -m 'full scaffold test'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 2", ctx);

    // Verify EVERY artifact that a user would expect after kicking off:
    const checks: Array<{ path: string; desc: string; shouldExist: boolean }> = [
      { path: PI_AGENT_DIR, desc: ".pi-agent/ directory", shouldExist: true },
      { path: LAUNCH_STATE_FILE, desc: "launch state file", shouldExist: true },
      { path: REGISTRY_FILE, desc: "worker registry", shouldExist: true },
      { path: join(PI_AGENT_DIR, ".bmad-mode.json"), desc: "BMAD mode config", shouldExist: true },
      { path: join(PI_AGENT_DIR, ".prompts"), desc: "prompts directory", shouldExist: true },
      { path: join(PI_AGENT_DIR, ".manager-instructions.md"), desc: "manager instructions", shouldExist: true },
      { path: join(PI_AGENT_DIR, ".manager"), desc: "manager directory", shouldExist: true },
      { path: WORKTREE_DIR, desc: "worktrees directory", shouldExist: true },
      { path: MAILBOX_DIR, desc: "mailboxes directory", shouldExist: true },
      { path: join(MAILBOX_DIR, "parent"), desc: "parent mailbox", shouldExist: true },
      { path: join(MAILBOX_DIR, "manager"), desc: "manager mailbox", shouldExist: true },
    ];

    for (const check of checks) {
      let exists = false;
      try { await stat(join(repo, check.path)); exists = true; } catch { /* */ }
      expect(exists).toBe(check.shouldExist);
    }

    // Registry should have active workers
    const registry = await readRegistry(repo);
    expect(Object.keys(registry.workers).length).toBeGreaterThan(0);

    // Queue should have pending items (for blocked workflows)
    const queue = await readQueue(repo);
    expect(queue.items.length).toBeGreaterThan(0);

    // Manager instructions should mention project name
    const mgrInstructions = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(mgrInstructions).toContain("FullScaffold");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 13: /harness:add works before /harness:init (auto-creates .pi-agent/)
  // ═════════════════════════════════════════════════════════════════════════
  it("/harness:add auto-creates .pi-agent/ if it doesn't exist (no init needed)", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Don't run /harness:init — just add a task directly
    await mock.getCommand("harness:add")!.handler("quick-fix Fix the bug", ctx);

    // .pi-agent/ should have been auto-created
    const goalPath = join(repo, PI_AGENT_DIR, "quick-fix.md");
    const content = await readFile(goalPath, "utf-8");
    expect(content).toContain("Fix the bug");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 14: Verify that /harness:bmad's L0 DAG is minimal
  // ═════════════════════════════════════════════════════════════════════════
  it("L0 project has minimal 4-workflow DAG: tech-spec → sprint → story → dev", async () => {
    await programmaticBmadInit(repo, "MinimalProject", 0);
    git("add -A && git commit -m 'L0 minimal test'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );

    // L0 should only have 4 workflows
    expect(bmadMode.workflows.length).toBe(4);
    const wfNames = bmadMode.workflows.map((w: any) => w.workflowName).sort();
    expect(wfNames).toEqual(["create-story", "dev-story", "sprint-planning", "tech-spec"]);

    // Only tech-spec should be active (no deps at entry)
    const active = bmadMode.workflows.filter((w: any) => w.status === "active");
    expect(active.length).toBe(1);
    expect(active[0].workflowName).toBe("tech-spec");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 15: Step count comparison across all entry points
  // ═════════════════════════════════════════════════════════════════════════
  it("documents step counts: auto=1, bmad=2, manual=3 (add only, init optional)", async () => {
    // This test validates the step count for each entry point:
    //
    // PATH A: /harness:auto (1 step)
    //   git repo → /harness:auto → done
    //   No BMAD config needed. No /harness:init needed.
    //
    // PATH B: BMAD via /harness:bmad (2 steps)
    //   git repo → write config+status → /harness:bmad → done
    //   /harness:init is NOT needed (auto-scaffolded).
    //   /bmad-init can be replaced with manual file creation.
    //
    // PATH C: Manual via /harness:launch (2-3 steps)
    //   git repo → /harness:add task1 goals → /harness:launch → done
    //   /harness:init is optional (/harness:add auto-creates .pi-agent/)
    //   Can add multiple tasks before launching.

    // Verify PATH C works in 2 steps (skip init)
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Step 1: Add (auto-creates .pi-agent/)
    await mock.getCommand("harness:add")!.handler("my-task Implement feature", ctx);

    // Step 2: Launch
    await mock.getCommand("harness:launch")!.handler("", ctx);

    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.sessions["my-task"]).toBeDefined();

    // So PATH C is actually 2 steps, not 3. /harness:init is redundant.
  });
});
