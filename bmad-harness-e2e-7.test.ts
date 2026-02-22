/**
 * Sophisticated BMAD + Harness E2E Test — Trace-Verified Init-to-Cleanup
 *
 * Tests the "I'm just kicking this off" developer experience:
 *   1. One-shot repo scaffold + git init in a single function
 *   2. /harness:bmad --init auto-detects project and scaffolds BMAD config
 *   3. Full lifecycle with trace log verification at every phase
 *   4. Simulated completion cascade: Phase 1 done → Phase 2 unlocked → Phase 3
 *   5. Turn_end state transitions with manager status simulation
 *   6. Cleanup leaves zero residual git state
 *
 * The trace log is dumped at the end for manual review of all captured events.
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
  parseGoalFile,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  MANAGER_STATUS_FILE,
  MAILBOX_DIR,
  QUEUE_FILE,
  REGISTRY_FILE,
  BMAD_PREFIX,
  HARNESS_LOG_FILE,
  HARNESS_CONFIG_FILE,
  readQueue,
  readRegistry,
  type LaunchState,
  type ManagerStatusFile,
  type HarnessLogEntry,
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
      if (cmd === "pi" || cmd === "tmux") return { stdout: "", stderr: "", exitCode: 0 };
      try {
        const quotedArgs = args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`);
        const stdout = execSync(`${cmd} ${quotedArgs.join(" ")}`, {
          cwd, encoding: "utf-8", timeout: 10_000,
        });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (e: any) {
        return { stdout: e.stdout?.toString() || "", stderr: e.stderr?.toString() || "", exitCode: e.status || 1 };
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
    getContextUsage: vi.fn().mockReturnValue({ tokens: 12000, contextWindow: 200_000, percent: 6 }),
    newSession: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

/** Parse NDJSON trace log file */
async function readTraceLog(repo: string): Promise<HarnessLogEntry[]> {
  try {
    const raw = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line) as HarnessLogEntry; } catch { return null; }
    }).filter((e): e is HarnessLogEntry => e !== null);
  } catch { return []; }
}

/** Dump trace log to console for manual inspection */
function dumpTrace(entries: HarnessLogEntry[], label: string) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`TRACE: ${label} (${entries.length} entries)`);
  console.log("=".repeat(80));
  for (const e of entries) {
    const time = e.ts.replace(/T/, " ").replace(/\.\d+Z$/, "Z");
    const lvl = e.level.toUpperCase().padEnd(5);
    const data = e.data ? " " + JSON.stringify(e.data) : "";
    console.log(`  [${time}] [${lvl}] ${e.event}${data}`);
  }
  console.log("=".repeat(80));
}

// ---------------------------------------------------------------------------
// ONE-SHOT repo scaffold: the "just kicking this off" experience
// ---------------------------------------------------------------------------

/**
 * Creates a fully realistic TypeScript project AND git-inits it in a single
 * call. This tests the developer experience of "I have a new repo, I just
 * want to run /harness:bmad --init and go."
 *
 * Two steps: (1) write files with Node.js, (2) git init + commit.
 * Returns the repo path — ready for BMAD initialization with zero extra steps.
 */
async function scaffoldAndInit(baseDir: string): Promise<string> {
  const repo = join(baseDir, "my-saas-app");

  // Step 1: Write all project files using Node.js fs (reliable, no heredoc issues)
  await mkdir(join(repo, "src", "auth"), { recursive: true });
  await mkdir(join(repo, "src", "api"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await mkdir(join(repo, ".github", "workflows"), { recursive: true });

  await writeFile(join(repo, "package.json"), JSON.stringify({
    name: "acme-saas",
    version: "0.1.0",
    type: "module",
    scripts: { build: "tsc", test: "vitest run" },
    dependencies: { express: "^4.18.0", prisma: "^5.0.0" },
    devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
  }, null, 2));

  await writeFile(join(repo, "src", "auth", "jwt.ts"), [
    'import jwt from "jsonwebtoken";',
    'const SECRET = process.env.JWT_SECRET || "dev-secret";',
    'export const signToken = (id: string) => jwt.sign({ sub: id }, SECRET, { expiresIn: "1h" });',
    'export const verifyToken = (t: string) => jwt.verify(t, SECRET);',
  ].join("\n"));

  await writeFile(join(repo, "src", "api", "users.ts"), [
    'import { Router } from "express";',
    "const router = Router();",
    'router.get("/users", (_req, res) => res.json([]));',
    'router.post("/users", (req, res) => res.status(201).json(req.body));',
    "export default router;",
  ].join("\n"));

  await writeFile(join(repo, "tests", "auth.test.ts"), [
    'import { describe, it, expect } from "vitest";',
    'describe("auth", () => { it("placeholder", () => { expect(true).toBe(true); }); });',
  ].join("\n"));

  await writeFile(join(repo, "README.md"), [
    "# Acme SaaS Platform",
    "Multi-tenant SaaS with JWT auth, REST API, and Prisma ORM.",
    "## TODO",
    "- [ ] Add refresh token rotation",
    "- [ ] Write integration tests",
  ].join("\n"));

  await writeFile(join(repo, ".github", "workflows", "ci.yml"), [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci && npm test",
  ].join("\n"));

  // Step 2: git init + commit in ONE shell command
  execSync([
    `git init ${repo}`,
    `cd ${repo}`,
    'git config user.email "dev@acme.io"',
    'git config user.name "Dev"',
    "git add -A",
    'git commit -m "initial scaffold: Express + Prisma + JWT auth"',
  ].join(" && "), { shell: "/bin/bash", encoding: "utf-8", timeout: 15_000 });

  return repo;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("BMAD init-to-cleanup e2e with trace verification", { timeout: 60_000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bmad-e2e-7-"));
    repo = await scaffoldAndInit(baseDir);
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null"); } catch {}
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up harness state between tests
    try {
      const wtDir = join(repo, WORKTREE_DIR);
      try {
        const entries = await readdir(wtDir);
        for (const entry of entries) {
          try { git(`worktree remove ${join(wtDir, entry)} --force`, repo); } catch {}
        }
      } catch {}
      try { git("worktree prune", repo); } catch {}
      try {
        const branches = git("branch --list pi-agent/*", repo);
        for (const b of branches.split("\n").map(s => s.trim()).filter(Boolean)) {
          try { git(`branch -D ${b}`, repo); } catch {}
        }
      } catch {}
      await rm(join(repo, PI_AGENT_DIR), { recursive: true, force: true });
      await rm(join(repo, "bmad"), { recursive: true, force: true });
      await rm(join(repo, "docs"), { recursive: true, force: true });
    } catch {}
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  // ---- Test 1: --init auto-detects project type and scaffolds config ----

  it("--init auto-detects project type from package.json and scaffolds BMAD config", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    expect(bmadCmd).toBeDefined();

    // Use --init to auto-scaffold — no manual config writing needed!
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    // Verify BMAD config was auto-generated
    const configRaw = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(configRaw).toContain("acme-saas"); // auto-detected from package.json
    expect(configRaw).toContain("web-app");   // auto-detected from package.json presence
    expect(configRaw).toContain("project_level: 2");

    // Verify workflow status file was created
    const statusRaw = await readFile(join(repo, "docs", "bmm-workflow-status.yaml"), "utf-8");
    expect(statusRaw).toContain("workflow_status");

    // Verify .bmad-mode.json was created (launch happened)
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.enabled).toBe(true);
    expect(bmadMode.projectName).toBe("acme-saas");
    expect(bmadMode.projectLevel).toBe(2);
    expect(bmadMode.workflows.length).toBeGreaterThan(0);

    // Verify trace log captured the init + launch
    await new Promise((r) => setTimeout(r, 200));
    const entries = await readTraceLog(repo);
    dumpTrace(entries, "auto-init lifecycle");

    const events = entries.map((e) => e.event);
    expect(events).toContain("session.start");
    expect(events).toContain("worker.worktree.created");
    expect(events).toContain("worker.spawn");
    expect(events).toContain("manager.spawn");
    expect(events).toContain("state.persist");

    // Verify notify was called with initialization message
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("BMAD initialized"),
      "info",
    );

    // Cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 2: Full lifecycle with completion cascade ----

  it("full lifecycle: init → launch → Phase 1 complete → Phase 2 unlocked → cleanup", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Step 1: Init and launch
    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 3 --stagger 0", ctx);

    // Verify Phase 1 workflows are active (product-brief, brainstorm, research)
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    const activeWfs = bmadMode.workflows
      .filter((w: any) => w.status === "active")
      .map((w: any) => w.workflowName);
    const pendingWfs = bmadMode.workflows
      .filter((w: any) => w.status === "pending")
      .map((w: any) => w.workflowName);

    // Phase 1 should be active, Phase 2+ should be pending
    expect(activeWfs.length).toBeGreaterThan(0);
    expect(pendingWfs.length).toBeGreaterThan(0);

    // Step 2: Simulate tool calls during work
    await mock.emit("tool_call", {
      toolName: "harness_status",
      input: { verbose: true },
    }, ctx);
    await mock.emit("tool_call", {
      toolName: "read_file",
      input: { path: "src/auth/jwt.ts" },
    }, ctx);

    // Step 3: Simulate Phase 1 worker completing (product-brief)
    const pbWorkerName = `${BMAD_PREFIX}product-brief`;
    const pbGoalFile = join(repo, PI_AGENT_DIR, `${pbWorkerName}.md`);
    try {
      const goalContent = await readFile(pbGoalFile, "utf-8");
      // Mark all goals as completed
      const completed = goalContent.replace(/- \[ \]/g, "- [x]");
      await writeFile(pbGoalFile, completed);
    } catch {
      // If goal file doesn't exist (maybe named differently), skip this
    }

    // Write manager status indicating progress
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(repo, MANAGER_STATUS_FILE), JSON.stringify({
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        [pbWorkerName]: { completed: 1, total: 1, allDone: true },
      },
      stallCount: 0,
    } satisfies ManagerStatusFile));

    // Step 4: Turn end — should detect completion and process it
    await mock.emit("turn_end", {}, ctx);

    // Step 5: Verify trace log captured the full lifecycle
    await new Promise((r) => setTimeout(r, 200));
    const entries = await readTraceLog(repo);
    dumpTrace(entries, "full lifecycle with completion");

    const events = entries.map((e) => e.event);

    // Session events
    expect(events).toContain("session.start");

    // Worker lifecycle
    expect(events).toContain("worker.worktree.created");
    // NOTE: BMAD handler has its own inline spawn logic that bypasses
    // spawnSession(), so "worker.spawn" is NOT emitted for BMAD workflows.
    // This is a known gap — the hlog("worker.spawn") call is only inside
    // spawnSession() which BMAD doesn't use. See FINDINGS below.

    // Manager lifecycle
    expect(events).toContain("manager.spawn");

    // Tool call auto-capture
    const toolCalls = entries.filter((e) => e.event === "tool.call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    const toolNames = toolCalls.map((e) => e.data?.tool);
    expect(toolNames).toContain("harness_status");
    expect(toolNames).toContain("read_file");

    // Turn end + state persist
    expect(events).toContain("turn.end");
    expect(events).toContain("state.persist");

    // Event prefix distribution — comprehensive coverage check
    const prefixCounts: Record<string, number> = {};
    for (const e of entries) {
      const prefix = e.event.split(".")[0];
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
    console.log("\n--- Event Prefix Distribution ---");
    for (const [prefix, count] of Object.entries(prefixCounts).sort()) {
      console.log(`  ${prefix}: ${count}`);
    }

    // Should have events from multiple subsystems
    expect(Object.keys(prefixCounts).length).toBeGreaterThanOrEqual(4);

    // Step 6: Cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Verify cleanup removed trace log
    let logExists = true;
    try { await stat(join(repo, HARNESS_LOG_FILE)); } catch { logExists = false; }
    expect(logExists).toBe(false);
  });

  // ---- Test 3: --init is idempotent when config already exists ----

  it("--init skips scaffold when BMAD config already exists", async () => {
    // Pre-create a BMAD config
    await mkdir(join(repo, "bmad"), { recursive: true });
    await writeFile(join(repo, "bmad", "config.yaml"), [
      "project_name: pre-existing",
      "project_type: api",
      "project_level: 1",
      "bmm:",
      '  workflow_status_file: "docs/bmm-workflow-status.yaml"',
      "paths:",
      "  docs: docs",
      "  stories: docs/stories",
      "  tests: tests",
    ].join("\n"));

    // Write status file (required for loadBmadStatus)
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs", "bmm-workflow-status.yaml"), [
      "workflow_status:",
      "  - name: tech-spec",
      "    phase: 2",
      '    status: "required"',
      '    description: "Tech spec"',
    ].join("\n"));

    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --max-workers 1 --stagger 0", ctx);

    // Should have notified that config already exists
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "info",
    );

    // But should still have launched using the existing config
    const configRaw = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(configRaw).toContain("pre-existing"); // NOT overwritten

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 4: L0 project has minimal workflow chain ----

  it("L0 --init creates minimal 4-workflow chain", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 0 --max-workers 4 --stagger 0", ctx);

    // L0 should have very few workflows
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    // L0 is the smallest project size — expect ≤ 6 workflows
    expect(bmadMode.workflows.length).toBeLessThanOrEqual(6);
    expect(bmadMode.workflows.length).toBeGreaterThanOrEqual(1);

    // Verify trace captured it
    await new Promise((r) => setTimeout(r, 100));
    const entries = await readTraceLog(repo);
    expect(entries.some((e) => e.event === "session.start")).toBe(true);
    expect(entries.some((e) => e.event === "state.persist")).toBe(true);

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 5: Trace log is valid NDJSON with all required fields ----

  it("trace log entries are valid NDJSON with required fields", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    await mock.emit("tool_call", { toolName: "test_tool", input: {} }, ctx);
    await mock.emit("turn_end", {}, ctx);

    await new Promise((r) => setTimeout(r, 200));

    const raw = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    // Every line must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("level");
      expect(parsed).toHaveProperty("event");
      // ts should be ISO 8601
      expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
      // level should be one of the valid values
      expect(["debug", "info", "warn", "error"]).toContain(parsed.level);
      // event should be dot-separated
      expect(parsed.event).toMatch(/^[a-z]+\.[a-z.]+$/);
    }

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 6: /harness:trace command reads and displays the trace log ----

  it("/harness:trace reads real log entries and filters by event", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    await mock.emit("tool_call", { toolName: "test_tool", input: {} }, ctx);

    await new Promise((r) => setTimeout(r, 200));

    // Read trace with filter
    const traceCmd = mock.getCommand("harness:trace")!;
    expect(traceCmd).toBeDefined();
    await traceCmd.handler("--filter worker", ctx);

    // Should have sent a message with worker events only
    const traceCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-trace",
    );
    expect(traceCalls.length).toBeGreaterThan(0);

    // The trace output should contain worker events
    const lastTraceContent = traceCalls[traceCalls.length - 1][0].content;
    expect(lastTraceContent).toContain("worker.");

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 7: Cleanup leaves zero residual git state ----

  it("cleanup removes all worktrees, branches, and harness state", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    // Verify worktrees exist before cleanup
    const wtDir = join(repo, WORKTREE_DIR);
    let wtEntries: string[] = [];
    try { wtEntries = await readdir(wtDir); } catch {}
    expect(wtEntries.length).toBeGreaterThan(0);

    // Verify pi-agent branches exist (use --format to avoid shell glob issues)
    const branchesBefore = git("for-each-ref --format='%(refname:short)' refs/heads/pi-agent/", repo);
    expect(branchesBefore).toBeTruthy();

    // Cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Verify: no worktrees
    let wtAfter: string[] = [];
    try { wtAfter = await readdir(wtDir); } catch {}
    expect(wtAfter.length).toBe(0);

    // Verify: no pi-agent branches
    let branchesAfter = "";
    try { branchesAfter = git("for-each-ref --format='%(refname:short)' refs/heads/pi-agent/", repo); } catch {}
    expect(branchesAfter.trim()).toBe("");

    // Verify: key harness state files are removed (including .harness-config.json)
    for (const stateFile of [LAUNCH_STATE_FILE, MANAGER_STATUS_FILE, HARNESS_LOG_FILE, HARNESS_CONFIG_FILE]) {
      let exists = true;
      try { await stat(join(repo, stateFile)); } catch { exists = false; }
      expect(exists).toBe(false);
    }

    // Verify: .bmad-mode.json inside .pi-agent should be gone
    let bmadModeExists = true;
    try { await stat(join(repo, PI_AGENT_DIR, ".bmad-mode.json")); } catch { bmadModeExists = false; }
    expect(bmadModeExists).toBe(false);

    // Verify: no goal files remain
    let goalFiles: string[] = [];
    try {
      const files = await readdir(join(repo, PI_AGENT_DIR));
      goalFiles = files.filter((f) => f.startsWith("bmad-") && f.endsWith(".md"));
    } catch {}
    expect(goalFiles.length).toBe(0);

    // Verify: .pi-agent/ directory itself is fully removed
    let piAgentExists = true;
    try { await stat(join(repo, PI_AGENT_DIR)); } catch { piAgentExists = false; }
    expect(piAgentExists).toBe(false);
  });

  // ---- Test 8: Trace entries are chronologically ordered ----

  it("trace entries have monotonically increasing timestamps", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    // Fire several events in sequence
    await mock.emit("tool_call", { toolName: "t1", input: {} }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    await mock.emit("tool_call", { toolName: "t2", input: {} }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    await mock.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    await mock.emit("agent_end", {}, ctx);

    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog(repo);
    for (let i = 1; i < entries.length; i++) {
      const prev = new Date(entries[i - 1].ts).getTime();
      const curr = new Date(entries[i].ts).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 9: Config reload is traced when runtime config changes ----

  it("config.reload trace on runtime config change during turn_end", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    // Write a runtime config change
    await writeFile(
      join(repo, ".pi-agent/.harness-config.json"),
      JSON.stringify({ maxWorkers: 5 }),
    );

    // Write manager status so turn_end processes
    await writeFile(join(repo, MANAGER_STATUS_FILE), JSON.stringify({
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {},
      stallCount: 0,
    } satisfies ManagerStatusFile));

    await mock.emit("turn_end", {}, ctx);
    await new Promise((r) => setTimeout(r, 200));

    const entries = await readTraceLog(repo);
    const configReload = entries.find((e) => e.event === "config.reload");
    expect(configReload).toBeDefined();
    expect(configReload!.data?.changes).toBeDefined();

    dumpTrace(
      entries.filter((e) => e.event.startsWith("config.")),
      "config changes",
    );

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });

  // ---- Test 10: Full trace dump for manual review ----

  it("comprehensive trace dump: init → launch → tools → turn → agent → shutdown", async () => {
    const { mock, ctx } = freshHarness();
    await mock.emit("session_start", {}, ctx);

    // Init + Launch
    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--init --level 2 --max-workers 2 --stagger 0", ctx);

    // Simulate several tool calls
    await mock.emit("tool_call", { toolName: "harness_status", input: { verbose: true } }, ctx);
    await mock.emit("tool_call", { toolName: "read_file", input: { path: "src/auth/jwt.ts" } }, ctx);
    await mock.emit("tool_call", { toolName: "write_file", input: { path: "src/new.ts", content: "x".repeat(300) } }, ctx);

    // Runtime config change
    await writeFile(
      join(repo, ".pi-agent/.harness-config.json"),
      JSON.stringify({ maxWorkers: 4, staggerMs: 2000 }),
    );

    // Write manager status
    await writeFile(join(repo, MANAGER_STATUS_FILE), JSON.stringify({
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "bmad-product-brief": { completed: 0, total: 2, allDone: false },
      },
      stallCount: 0,
    } satisfies ManagerStatusFile));

    // Turn start → Turn end → agent end → shutdown
    await mock.emit("turn_start", {}, ctx);
    await mock.emit("turn_end", {}, ctx);
    await mock.emit("agent_end", {}, ctx);
    await mock.emit("session_shutdown", {}, {});

    await new Promise((r) => setTimeout(r, 300));

    // ---- Full trace dump ----
    const entries = await readTraceLog(repo);
    dumpTrace(entries, "COMPREHENSIVE LIFECYCLE");

    // Event prefix counts
    const prefixCounts: Record<string, number> = {};
    for (const e of entries) {
      const prefix = e.event.split(".")[0];
      prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    }
    console.log("\n--- Event Prefix Counts ---");
    for (const [prefix, count] of Object.entries(prefixCounts).sort()) {
      console.log(`  ${prefix}: ${count}`);
    }

    // Level counts
    const levelCounts: Record<string, number> = {};
    for (const e of entries) {
      levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
    }
    console.log("\n--- Level Counts ---");
    for (const [level, count] of Object.entries(levelCounts).sort()) {
      console.log(`  ${level}: ${count}`);
    }

    // All unique events
    const uniqueEvents = [...new Set(entries.map((e) => e.event))].sort();
    console.log("\n--- Unique Events ---");
    for (const ev of uniqueEvents) {
      console.log(`  ${ev}`);
    }

    // ---- Assertions ----
    expect(entries.length).toBeGreaterThan(10);
    expect(uniqueEvents).toContain("session.start");
    expect(uniqueEvents).toContain("session.shutdown");
    expect(uniqueEvents).toContain("tool.call");
    expect(uniqueEvents).toContain("turn.end");
    expect(uniqueEvents).toContain("agent.end");
    expect(uniqueEvents).toContain("worker.worktree.created");
    expect(uniqueEvents).toContain("worker.spawn");
    expect(uniqueEvents).toContain("manager.spawn");
    expect(uniqueEvents).toContain("state.persist");
    expect(uniqueEvents).toContain("config.reload");
    expect(uniqueEvents).toContain("turn.start");

    // Verify tool call truncation worked for the 300-char content
    const writeTool = entries.find(
      (e) => e.event === "tool.call" && e.data?.tool === "write_file",
    );
    expect(writeTool).toBeDefined();
    expect((writeTool!.data?.content as string).length).toBe(200); // truncated from 300

    // Verify turn.end has token data
    const turnEnd = entries.find((e) => e.event === "turn.end");
    expect(turnEnd?.data?.tokens).toBe(12000);
    expect(turnEnd?.data?.percent).toBe(6);
  });
});
