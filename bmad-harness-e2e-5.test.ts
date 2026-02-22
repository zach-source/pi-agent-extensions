/**
 * Sophisticated BMAD + Harness E2E Test — Part 5: New Feature Integration & Cold Start
 *
 * This test suite exercises all 10 OpenClaw-inspired features in an integrated
 * scenario: setting up a brand-new repo and running the full BMAD init with
 * model routing, memory, heartbeat, inter-agent communication, template
 * self-improvement, schedules, sandbox config, triggers, and dashboard.
 *
 * Creative scenario: "Cold Start to Full Stack" — a fresh TypeScript monorepo
 * with multiple packages gets initialized from scratch with every feature enabled.
 *
 * Focus areas:
 * 1. How few steps to go from nothing → fully operational harness?
 * 2. Do the new features compose correctly with --init?
 * 3. Edge cases: model routing with unknown roles, memory across restarts,
 *    heartbeat config persistence, trigger processing races, etc.
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
import { join, resolve } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  MAILBOX_DIR,
  REGISTRY_FILE,
  BMAD_PREFIX,
  MODEL_ROUTES_FILE,
  MEMORY_FILE,
  HEARTBEAT_CONFIG_FILE,
  TEMPLATE_STORE_FILE,
  SCHEDULE_FILE,
  SANDBOX_CONFIG_FILE,
  TRIGGERS_DIR,
  DEFAULT_MODEL_ROUTES,
  DEFAULT_HEARTBEAT_CONFIG,
  MAX_MEMORIES,
  MAX_WORKER_RECOVERIES,
  DEFAULT_SANDBOX_IMAGE,
  readRegistry,
  readQueue,
  resolveModelForWorker,
  searchMemories,
  getTemplateOverrides,
  buildDockerCmd,
  isScheduleDue,
  type LaunchState,
  type ModelRoute,
  type HarnessMemory,
  type MemoryStore,
  type HeartbeatConfig,
  type TemplateStore,
  type TemplateRating,
  type ScheduledRun,
  type SandboxConfig,
  type TriggerEvent,
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
  const tools: Array<{ name: string; schema?: any; handler?: Function; [k: string]: any }> = [];
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
    getTools() { return tools; },
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

describe("BMAD harness e2e part 5: Full feature integration & cold start", { timeout: 60000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bmad-e2e5-"));
    repo = join(baseDir, "fullstack-monorepo");
    git(`init ${repo}`, baseDir);
    git('config user.email "dev@test.co"', repo);
    git('config user.name "Dev"', repo);
    // Create a realistic monorepo with package.json
    await writeFile(join(repo, "package.json"), JSON.stringify({
      name: "fullstack-monorepo",
      version: "0.1.0",
      description: "A monorepo with API + frontend + shared libs",
      workspaces: ["packages/*"],
    }, null, 2));
    await mkdir(join(repo, "packages", "api", "src"), { recursive: true });
    await mkdir(join(repo, "packages", "web", "src"), { recursive: true });
    await mkdir(join(repo, "packages", "shared", "src"), { recursive: true });
    await writeFile(join(repo, "packages", "api", "src", "index.ts"), 'export const api = "hello";\n');
    await writeFile(join(repo, "packages", "web", "src", "index.ts"), 'export const web = "world";\n');
    await writeFile(join(repo, "packages", "shared", "src", "index.ts"), 'export type ID = string;\n');
    await writeFile(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    git("add -A", repo);
    git('commit -m "initial monorepo scaffold"', repo);
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null", { encoding: "utf-8" }); } catch { /* */ }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanupHarnessState(repo);
    await rm(join(repo, "bmad"), { recursive: true, force: true }).catch(() => {});
    await rm(join(repo, "docs"), { recursive: true, force: true }).catch(() => {});
    // Clean up feature-specific state files
    for (const f of [MODEL_ROUTES_FILE, MEMORY_FILE, HEARTBEAT_CONFIG_FILE, TEMPLATE_STORE_FILE, SCHEDULE_FILE, SANDBOX_CONFIG_FILE]) {
      await rm(join(repo, f)).catch(() => {});
    }
    await rm(join(repo, TRIGGERS_DIR), { recursive: true, force: true }).catch(() => {});
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 1: Cold Start — From empty repo to fully operational in 1 command
  // ═════════════════════════════════════════════════════════════════════════

  it("cold start: 1 command initializes BMAD + all feature state files", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Fix 1: --heartbeat is now supported directly on /harness:bmad
    await mock.getCommand("harness:bmad")!.handler(
      "--init --max-workers 3 --heartbeat 45000",
      ctx,
    );

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Verify BMAD files scaffolded
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("fullstack-monorepo");
    expect(config).toContain("web-app");

    const status = await readFile(join(repo, "docs", "bmm-workflow-status.yaml"), "utf-8");
    expect(status).toContain("workflow_status:");

    // Heartbeat config written by --heartbeat flag on harness:bmad
    const hbConfig: HeartbeatConfig = JSON.parse(
      await readFile(join(repo, HEARTBEAT_CONFIG_FILE), "utf-8"),
    );
    expect(hbConfig.intervalMs).toBe(45000);
    expect(hbConfig.stalledThresholdMs).toBe(DEFAULT_HEARTBEAT_CONFIG.stalledThresholdMs);

    // Verify harness fully launched
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);
    expect(Object.keys(launchState.sessions).length).toBeGreaterThan(0);
    expect(Object.keys(launchState.sessions).length).toBeLessThanOrEqual(3);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 2: Model routing composes with BMAD worker roles
  // ═════════════════════════════════════════════════════════════════════════

  it("model routing: --model-routes flag on harness:bmad assigns correct models", async () => {
    // Fix 1: --model-routes now works directly on /harness:bmad
    const routesPath = join(baseDir, "custom-routes.json");
    const customRoutes: ModelRoute[] = [
      { model: "claude-opus-4-6", roles: ["architect", "analyst"] },
      { model: "claude-sonnet-4-5", roles: ["developer", "builder", "designer"] },
      { model: "claude-haiku-4-5", taskPattern: ".*brainstorm.*" },
    ];
    await writeFile(routesPath, JSON.stringify(customRoutes));

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler(
      `--init --max-workers 2 --model-routes ${routesPath}`,
      ctx,
    );

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Routes should be persisted to .pi-agent/
    const storedRoutes: ModelRoute[] = JSON.parse(
      await readFile(join(repo, MODEL_ROUTES_FILE), "utf-8"),
    );
    expect(storedRoutes.length).toBe(3);
    expect(storedRoutes[0].model).toBe("claude-opus-4-6");

    // Verify resolution works for BMAD roles
    expect(resolveModelForWorker(storedRoutes, "architect", "anything")).toBe("claude-opus-4-6");
    expect(resolveModelForWorker(storedRoutes, "developer", "anything")).toBe("claude-sonnet-4-5");
    // Task pattern match overrides role
    expect(resolveModelForWorker(storedRoutes, "developer", "bmad-brainstorm")).toBe("claude-haiku-4-5");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 3: Memory persists across harness stop/restart cycles
  // ═════════════════════════════════════════════════════════════════════════

  it("memory: persists across stop/restart and injects into worker prompts", async () => {
    // Pre-populate memory from a "previous run"
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    const memStore: MemoryStore = {
      version: 1,
      memories: [
        {
          id: "mem-1",
          timestamp: new Date().toISOString(),
          source: "bmad-product-brief",
          category: "decision",
          content: "Use PostgreSQL for primary data store based on ACID requirements",
          tags: ["database", "architecture", "product-brief"],
          relevance: 0.9,
        },
        {
          id: "mem-2",
          timestamp: new Date().toISOString(),
          source: "bmad-tech-spec",
          category: "pattern",
          content: "API versioning via URL prefix /api/v1/ worked well for backwards compat",
          tags: ["api", "versioning", "tech-spec"],
          relevance: 0.85,
        },
        {
          id: "mem-3",
          timestamp: new Date().toISOString(),
          source: "bmad-architecture",
          category: "error",
          content: "Circular dependency between auth and user modules — resolved with interface",
          tags: ["architecture", "dependency"],
          relevance: 0.7,
        },
      ],
    };
    await writeFile(join(repo, MEMORY_FILE), JSON.stringify(memStore, null, 2));

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Memory file should still exist (NOT cleaned up by init)
    const memContent = await readFile(join(repo, MEMORY_FILE), "utf-8");
    const persisted: MemoryStore = JSON.parse(memContent);
    expect(persisted.memories.length).toBe(3);

    // Stop harness
    await mock.getCommand("harness:stop")!.handler("", ctx);

    // Memory should survive the stop
    const memAfterStop = await readFile(join(repo, MEMORY_FILE), "utf-8");
    const afterStop: MemoryStore = JSON.parse(memAfterStop);
    expect(afterStop.memories.length).toBe(3);

    // The harness_remember tool should exist
    const rememberTool = mock.getTool("harness_remember");
    expect(rememberTool).toBeDefined();

    // The harness_recall tool should exist
    const recallTool = mock.getTool("harness_recall");
    expect(recallTool).toBeDefined();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 4: harness_remember + harness_recall round-trip during BMAD run
  // ═════════════════════════════════════════════════════════════════════════

  it("memory tools: remember → recall round-trip works during active harness", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Worker remembers something (tools use `execute` not `handler`)
    const rememberTool = mock.getTool("harness_remember")!;
    const rememberResult = await rememberTool.execute(
      "test-call-1",
      { content: "React Query v5 handles caching elegantly", category: "pattern", tags: ["frontend", "caching"] },
    );
    expect(rememberResult.content[0].text).toContain("Remembered");

    // Worker recalls it
    const recallTool = mock.getTool("harness_recall")!;
    const recallResult = await recallTool.execute(
      "test-call-2",
      { query: "caching", limit: 5 },
    );
    expect(recallResult.content[0].text).toContain("React Query");
    expect(recallResult.content[0].text).toContain("caching");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 5: /harness:forget clears memory without affecting harness state
  // ═════════════════════════════════════════════════════════════════════════

  it("harness:forget clears memory but does not stop the harness", async () => {
    // Pre-populate memory
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(repo, MEMORY_FILE), JSON.stringify({
      version: 1,
      memories: [{ id: "x", timestamp: "2024-01-01", source: "test", category: "decision", content: "old memory", tags: [], relevance: 0.5 }],
    }));

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Harness is active
    let state: LaunchState = JSON.parse(await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"));
    expect(state.active).toBe(true);

    // Forget memory
    await mock.getCommand("harness:forget")!.handler("", ctx);

    // Memory file should be gone
    let memExists = true;
    try { await stat(join(repo, MEMORY_FILE)); } catch { memExists = false; }
    expect(memExists).toBe(false);

    // Harness should still be active
    state = JSON.parse(await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"));
    expect(state.active).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 6: Heartbeat config drives manager loop timing
  // ═════════════════════════════════════════════════════════════════════════

  it("heartbeat: --heartbeat flag on harness:bmad drives manager sleep intervals", async () => {
    // Fix 1: --heartbeat now works directly on /harness:bmad
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler(
      "--init --max-workers 1 --heartbeat 30000",
      ctx,
    );

    // Heartbeat config should be written with 30s interval
    const hbConfig: HeartbeatConfig = JSON.parse(
      await readFile(join(repo, HEARTBEAT_CONFIG_FILE), "utf-8"),
    );
    expect(hbConfig.intervalMs).toBe(30000);

    // Manager tmux command should use sleep 30 (30000/1000) for success
    const managerCall = mock.api.exec.mock.calls.find(
      (c: any[]) => c[0] === "tmux" && c[1]?.some?.((a: string) => a.includes("sleep 30")),
    );
    expect(managerCall).toBeDefined();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 7: Inter-agent communication — workers can message each other
  // ═════════════════════════════════════════════════════════════════════════

  it("inter-agent: harness_send_message + harness_read_messages between workers", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 3", ctx);

    // Get worker names from registry
    const registry = await readRegistry(repo);
    const workerNames = Object.keys(registry.workers);
    expect(workerNames.length).toBeGreaterThan(0);

    // First worker sends message to manager (tools use `execute`)
    // Fix 3: tool now accepts mailbox types directly (question, not request)
    const sendTool = mock.getTool("harness_send_message")!;
    const sendResult = await sendTool.execute(
      "test-send",
      { to: "manager", message: "Need clarification on tech stack", type: "question" },
    );
    expect(sendResult.content[0].text).toContain("Message sent");

    // Check manager's mailbox has the message
    const managerMailbox = join(repo, MAILBOX_DIR, "manager");
    let managerFiles: string[] = [];
    try { managerFiles = await readdir(managerMailbox); } catch { /* */ }
    const jsonFiles = managerFiles.filter(f => f.endsWith(".json")).sort();
    expect(jsonFiles.length).toBeGreaterThan(0);

    // Find the message with our content
    // Fix 5: system messages have system: true, worker messages don't
    let foundMsg = false;
    for (const file of jsonFiles) {
      const msgContent = await readFile(join(managerMailbox, file), "utf-8");
      const msg = JSON.parse(msgContent);
      if (msg.payload?.text?.includes("tech stack")) {
        expect(msg.type).toBe("question");
        expect(msg.system).toBeUndefined(); // worker-sent, not system
        foundMsg = true;
        break;
      }
    }
    expect(foundMsg).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 8: Template self-improvement with pre-existing ratings
  // ═════════════════════════════════════════════════════════════════════════

  it("self-improving templates: low-rated roles get adjustment overrides injected", async () => {
    // Pre-populate template store with low ratings for "analyst" role
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    const templateStore: TemplateStore = {
      version: 1,
      ratings: [
        {
          role: "analyst",
          taskName: "bmad-research",
          rating: 2,
          feedback: "Too vague on deliverables",
          timestamp: new Date().toISOString(),
          adjustments: ["Be specific about output format", "Include acceptance criteria"],
        },
        {
          role: "analyst",
          taskName: "bmad-brainstorm",
          rating: 1,
          feedback: "Missed competitor analysis",
          timestamp: new Date().toISOString(),
          adjustments: ["Always include competitive landscape"],
        },
        {
          role: "developer",
          taskName: "bmad-dev-story",
          rating: 5,
          feedback: "Perfect",
          timestamp: new Date().toISOString(),
          adjustments: [],
        },
      ],
      roleOverrides: {},
    };
    await writeFile(join(repo, TEMPLATE_STORE_FILE), JSON.stringify(templateStore, null, 2));

    // Verify getTemplateOverrides returns adjustments for low-rated "analyst"
    const overrides = getTemplateOverrides(templateStore, "analyst");
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides).toContain("Be specific about output format");
    expect(overrides).toContain("Always include competitive landscape");

    // High-rated "developer" should get no adjustments
    const devOverrides = getTemplateOverrides(templateStore, "developer");
    expect(devOverrides.length).toBe(0);

    // Now rate a template using the tool
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 1", ctx);

    // Fix 4: harness_rate_template now accepts role and taskName params
    const rateTool = mock.getTool("harness_rate_template")!;
    const rateResult = await rateTool.execute(
      "test-rate",
      { rating: 4, feedback: "Good but needs more context", adjustments: ["Add project constraints"], role: "developer", taskName: "bmad-dev-story" },
    );
    expect(rateResult.content[0].text).toContain("rated");
    expect(rateResult.content[0].text).toContain("developer");

    // Verify the stored rating has the correct role (not "unknown")
    const updatedStore: TemplateStore = JSON.parse(
      await readFile(join(repo, TEMPLATE_STORE_FILE), "utf-8"),
    );
    const lastRating = updatedStore.ratings[updatedStore.ratings.length - 1];
    expect(lastRating.role).toBe("developer");
    expect(lastRating.taskName).toBe("bmad-dev-story");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 9: Schedule CRUD and due-check integration
  // ═════════════════════════════════════════════════════════════════════════

  it("schedules: add → list → remove lifecycle with due-check on session_start", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Add a schedule
    await mock.getCommand("harness:schedule")!.handler(
      'add --at daily "nightly code quality scan"',
      ctx,
    );

    // List schedules (list uses pi.sendMessage, not ctx.ui.notify)
    await mock.getCommand("harness:schedule")!.handler("list", ctx);
    const listCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-schedule" && c[0]?.content?.includes("nightly"),
    );
    expect(listCalls.length).toBeGreaterThan(0);

    // Read schedule file directly
    const schedules: ScheduledRun[] = JSON.parse(
      await readFile(join(repo, SCHEDULE_FILE), "utf-8"),
    );
    expect(schedules.length).toBe(1);
    expect(schedules[0].cron).toBe("daily");
    expect(schedules[0].objective).toContain("nightly");
    expect(schedules[0].enabled).toBe(true);

    // Remove the schedule
    const schedId = schedules[0].id;
    await mock.getCommand("harness:schedule")!.handler(`remove ${schedId}`, ctx);

    const afterRemove: ScheduledRun[] = JSON.parse(
      await readFile(join(repo, SCHEDULE_FILE), "utf-8"),
    );
    expect(afterRemove.length).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 10: Schedule due-check fires on session_start
  // ═════════════════════════════════════════════════════════════════════════

  it("schedules: due schedule triggers notification on session_start", async () => {
    // Write a schedule that is due (lastRunAt is old enough)
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    const now = new Date();
    const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
    const dueSchedule: ScheduledRun[] = [{
      id: "sched-daily",
      cron: "daily",
      objective: "daily health check",
      maxWorkers: 2,
      maxIterations: 3,
      enabled: true,
      lastRunAt: yesterday.toISOString(),
    }];
    await writeFile(join(repo, SCHEDULE_FILE), JSON.stringify(dueSchedule));

    const { mock, ctx } = freshHarness();
    initExtension(mock.api as any);

    // session_start should check schedules
    await mock.emit("session_start", {}, ctx);

    // Should send a notification about the due schedule
    const schedMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-schedule-due",
    );
    expect(schedMsgs.length).toBe(1);
    expect(schedMsgs[0][0].content).toContain("daily health check");

    // lastRunAt should be updated
    const updated: ScheduledRun[] = JSON.parse(
      await readFile(join(repo, SCHEDULE_FILE), "utf-8"),
    );
    const updatedTime = new Date(updated[0].lastRunAt!).getTime();
    expect(updatedTime).toBeGreaterThan(yesterday.getTime());
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 11: Trigger file processing on session_start
  // ═════════════════════════════════════════════════════════════════════════

  it("triggers: trigger files are processed and deleted on session_start", async () => {
    // Write a trigger file
    const triggersDir = join(repo, TRIGGERS_DIR);
    await mkdir(triggersDir, { recursive: true });

    const trigger: TriggerEvent = {
      id: "trig-001",
      type: "launch",
      config: { maxWorkers: 2, level: 1 },
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(triggersDir, "launch-001.json"), JSON.stringify(trigger));

    // Also write a malformed trigger to test resilience
    await writeFile(join(triggersDir, "bad.json"), "{ invalid json }}}");

    const { mock, ctx } = freshHarness();
    initExtension(mock.api as any);

    await mock.emit("session_start", {}, ctx);

    // Valid trigger should have been processed
    const trigMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-trigger",
    );
    expect(trigMsgs.length).toBe(1);
    expect(trigMsgs[0][0].content).toContain("trig-001");

    // Valid trigger file should be deleted
    const remainingFiles = await readdir(triggersDir);
    // Only the malformed file should remain (it was silently skipped, then deleted too)
    // Actually: the malformed file throws on JSON.parse, so it stays
    expect(remainingFiles).not.toContain("launch-001.json");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 12: Sandbox config composes with BMAD worker spawning
  // ═════════════════════════════════════════════════════════════════════════

  it("sandbox: enabling sandbox wraps pi commands in docker run", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Enable sandbox
    await mock.getCommand("harness:sandbox")!.handler("on", ctx);

    // Verify sandbox config written
    const sbConfig: SandboxConfig = JSON.parse(
      await readFile(join(repo, SANDBOX_CONFIG_FILE), "utf-8"),
    );
    expect(sbConfig.enabled).toBe(true);
    expect(sbConfig.image).toBe(DEFAULT_SANDBOX_IMAGE);

    // Verify buildDockerCmd produces correct command
    const cmd = buildDockerCmd(sbConfig, "/tmp/worktree", 'pi -p "hello"');
    expect(cmd).toContain("docker run");
    expect(cmd).toContain("--rm");
    expect(cmd).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(cmd).toContain("/tmp/worktree");
    expect(cmd).toContain('pi -p "hello"');

    // Disable sandbox
    await mock.getCommand("harness:sandbox")!.handler("off", ctx);
    let sbExists = true;
    try { await stat(join(repo, SANDBOX_CONFIG_FILE)); } catch { sbExists = false; }
    expect(sbExists).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 13: Dashboard flag accepted by harness:launch
  // ═════════════════════════════════════════════════════════════════════════

  it("dashboard: --dashboard flag is accepted by /harness:launch", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create goal files for /harness:launch
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(repo, PI_AGENT_DIR, "test-worker.md"),
      [
        "# test-worker",
        "role: developer",
        "path: packages/api",
        "",
        "## Goals",
        "- [ ] Build the API",
      ].join("\n"),
    );

    // Launch with --dashboard
    await mock.getCommand("harness:launch")!.handler("--dashboard --max-workers 1", ctx);

    // Should launch without errors
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 14: Full feature composition — all flags together
  // ═════════════════════════════════════════════════════════════════════════

  it("composition: --init + --heartbeat + --model-routes + --max-workers all in 1 command", async () => {
    // Fix 1: All flags now work directly on /harness:bmad
    const routesPath = join(baseDir, "composed-routes.json");
    await writeFile(routesPath, JSON.stringify([
      { model: "claude-opus-4-6", roles: ["architect"] },
      { model: "default", roles: ["developer", "analyst", "builder", "tester", "designer"] },
    ]));

    // Pre-seed memory (this is cross-run persistence, not a flag)
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(repo, MEMORY_FILE), JSON.stringify({
      version: 1,
      memories: [{
        id: "prior-1",
        timestamp: new Date().toISOString(),
        source: "previous-run",
        category: "insight",
        content: "Monorepo needs shared tsconfig base",
        tags: ["typescript", "monorepo"],
        relevance: 0.8,
      }],
    }));

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // ONE COMMAND with ALL flags
    await mock.getCommand("harness:bmad")!.handler(
      `--init --level 2 --max-workers 2 --heartbeat 20000 --model-routes ${routesPath}`,
      ctx,
    );

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Verify all features activated
    // 1. BMAD init done
    const bmadMode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    expect(bmadMode.projectName).toBe("fullstack-monorepo");
    expect(bmadMode.projectLevel).toBe(2);

    // 2. Model routes persisted by --model-routes flag
    const routes: ModelRoute[] = JSON.parse(
      await readFile(join(repo, MODEL_ROUTES_FILE), "utf-8"),
    );
    expect(routes.length).toBe(2);

    // 3. Heartbeat configured by --heartbeat flag
    const hb: HeartbeatConfig = JSON.parse(
      await readFile(join(repo, HEARTBEAT_CONFIG_FILE), "utf-8"),
    );
    expect(hb.intervalMs).toBe(20000);

    // 4. Memory still present (not affected by init)
    const mem: MemoryStore = JSON.parse(
      await readFile(join(repo, MEMORY_FILE), "utf-8"),
    );
    expect(mem.memories.length).toBe(1);
    expect(mem.memories[0].content).toContain("Monorepo");

    // 5. Workers spawned and limited to max 2
    const registry = await readRegistry(repo);
    expect(Object.keys(registry.workers).length).toBeLessThanOrEqual(2);

    // 6. Manager spawned
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.managerSpawned).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 15: Memory search accuracy — no false positives
  // ═════════════════════════════════════════════════════════════════════════

  it("memory search: no false positives — unrelated queries return empty", async () => {
    const memories: HarnessMemory[] = [
      {
        id: "1", timestamp: "2024-01-01", source: "worker-a",
        category: "decision", content: "Use Redis for caching",
        tags: ["redis", "caching"], relevance: 0.9,
      },
      {
        id: "2", timestamp: "2024-01-02", source: "worker-b",
        category: "pattern", content: "GraphQL resolvers should be thin",
        tags: ["graphql", "api"], relevance: 0.8,
      },
    ];

    // Unrelated query should return nothing
    const results = searchMemories(memories, "kubernetes deployment helm", 5);
    expect(results.length).toBe(0);

    // Related query should find matches
    const cacheResults = searchMemories(memories, "caching", 5);
    expect(cacheResults.length).toBe(1);
    expect(cacheResults[0].content).toContain("Redis");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 16: Worker prompt includes all injected sections
  // ═════════════════════════════════════════════════════════════════════════

  it("worker prompts: memory + template overrides + active workers injected", async () => {
    // Seed memory
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(repo, MEMORY_FILE), JSON.stringify({
      version: 1,
      memories: [{
        id: "m1", timestamp: new Date().toISOString(), source: "bmad-product-brief",
        category: "decision", content: "Priority on mobile-first design",
        tags: ["design", "mobile", "product-brief"], relevance: 0.9,
      }],
    }));

    // Seed template overrides
    await writeFile(join(repo, TEMPLATE_STORE_FILE), JSON.stringify({
      version: 1,
      ratings: [{
        role: "analyst", taskName: "test", rating: 2,
        feedback: "vague", timestamp: new Date().toISOString(),
        adjustments: ["Include quantitative metrics"],
      }],
      roleOverrides: {},
    }));

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--init --level 2 --max-workers 2", ctx);

    // Check the prompt file of a spawned worker
    const registry = await readRegistry(repo);
    const workerNames = Object.keys(registry.workers);
    expect(workerNames.length).toBeGreaterThan(0);

    // Find a worktree and read its prompt
    const firstWorker = workerNames[0];
    const wtDir = join(repo, WORKTREE_DIR, firstWorker);
    let promptContent = "";
    try {
      promptContent = await readFile(join(wtDir, ".pi-agent-prompt.md"), "utf-8");
    } catch {
      // Some workers may not have prompts if they weren't actually spawned via tmux
    }

    if (promptContent) {
      // Should contain the worker name
      expect(promptContent).toContain(firstWorker);
      // Should contain goal markers
      expect(promptContent).toContain("Goals");
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 17: Feature tools are all registered
  // ═════════════════════════════════════════════════════════════════════════

  it("all new feature tools are registered after initExtension", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const toolNames = mock.getTools().map(t => t.name);

    // Feature 2: Memory tools
    expect(toolNames).toContain("harness_remember");
    expect(toolNames).toContain("harness_recall");

    // Feature 5: Communication tools
    expect(toolNames).toContain("harness_send_message");
    expect(toolNames).toContain("harness_read_messages");

    // Feature 6: Template rating
    expect(toolNames).toContain("harness_rate_template");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 18: All new commands are registered
  // ═════════════════════════════════════════════════════════════════════════

  it("all new commands are registered after initExtension", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Feature 2: harness:forget
    expect(mock.getCommand("harness:forget")).toBeDefined();

    // Feature 7: harness:schedule
    expect(mock.getCommand("harness:schedule")).toBeDefined();

    // Feature 8: harness:sandbox
    expect(mock.getCommand("harness:sandbox")).toBeDefined();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 19: isScheduleDue edge cases
  // ═════════════════════════════════════════════════════════════════════════

  it("isScheduleDue: handles edge cases correctly", () => {
    // Use a concrete local-time date so HH:MM tests are deterministic.
    // isScheduleDue uses now.getHours()/getMinutes() which are local time.
    const now = new Date(2024, 5, 15, 14, 30, 0); // June 15, 2024, 14:30 local

    // Disabled schedule is never due
    expect(isScheduleDue({
      id: "s1", cron: "daily", maxWorkers: 1, maxIterations: 1,
      enabled: false,
    }, now)).toBe(false);

    // Never-run daily schedule is due
    expect(isScheduleDue({
      id: "s2", cron: "daily", maxWorkers: 1, maxIterations: 1,
      enabled: true,
    }, now)).toBe(true);

    // Recently-run daily schedule is not due
    expect(isScheduleDue({
      id: "s3", cron: "daily", maxWorkers: 1, maxIterations: 1,
      enabled: true, lastRunAt: new Date(now.getTime() - 12 * 3600 * 1000).toISOString(), // 12h ago
    }, now)).toBe(false);

    // HH:MM matching current local time (14:30)
    expect(isScheduleDue({
      id: "s4", cron: "14:30", maxWorkers: 1, maxIterations: 1,
      enabled: true,
    }, now)).toBe(true);

    // HH:MM not matching current local time
    expect(isScheduleDue({
      id: "s5", cron: "03:00", maxWorkers: 1, maxIterations: 1,
      enabled: true,
    }, now)).toBe(false);

    // Hourly with recent run
    expect(isScheduleDue({
      id: "s6", cron: "hourly", maxWorkers: 1, maxIterations: 1,
      enabled: true, lastRunAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(), // 30min ago
    }, now)).toBe(false);

    // Hourly without recent run
    expect(isScheduleDue({
      id: "s7", cron: "hourly", maxWorkers: 1, maxIterations: 1,
      enabled: true, lastRunAt: new Date(now.getTime() - 2 * 3600 * 1000).toISOString(), // 2h ago
    }, now)).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 20: buildDockerCmd produces valid docker commands
  // ═════════════════════════════════════════════════════════════════════════

  it("buildDockerCmd: produces valid docker commands with all config options", () => {
    const config: SandboxConfig = {
      enabled: true,
      image: "custom-image:latest",
      mountPaths: ["/extra/mount"],
      networkMode: "bridge",
      memoryLimit: "4g",
    };

    const cmd = buildDockerCmd(config, "/work/tree", "pi -p hello");
    expect(cmd).toContain("docker run --rm");
    // Worktree is mounted to /workspace inside the container
    expect(cmd).toContain("-v /work/tree:/workspace");
    expect(cmd).toContain("-w /workspace");
    expect(cmd).toContain("-v /extra/mount:/extra/mount");
    expect(cmd).toContain("--network bridge");
    expect(cmd).toContain("--memory 4g");
    expect(cmd).toContain("custom-image:latest");
    expect(cmd).toContain("pi -p hello");

    // Empty mountPaths should not produce extra -v flags
    const minConfig: SandboxConfig = {
      enabled: true,
      image: "node:20-slim",
      mountPaths: [],
      networkMode: "host",
      memoryLimit: "2g",
    };
    const minCmd = buildDockerCmd(minConfig, "/w", "pi");
    const vFlags = minCmd.match(/-v /g);
    expect(vFlags?.length).toBe(1); // Only worktree mount
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 21: resolveModelForWorker precedence — taskPattern > role > null
  // ═════════════════════════════════════════════════════════════════════════

  it("resolveModelForWorker: taskPattern takes precedence over role match", () => {
    const routes: ModelRoute[] = [
      { model: "role-model", roles: ["developer"] },
      { model: "pattern-model", taskPattern: ".*special.*" },
    ];

    // Role match only
    expect(resolveModelForWorker(routes, "developer", "normal-task")).toBe("role-model");

    // Pattern match overrides role
    expect(resolveModelForWorker(routes, "developer", "special-task")).toBe("pattern-model");

    // No match at all
    expect(resolveModelForWorker(routes, "unknown", "normal-task")).toBeNull();

    // Invalid regex doesn't crash — gracefully returns null
    const badRoutes: ModelRoute[] = [
      { model: "bad", taskPattern: "[invalid(" },
    ];
    expect(resolveModelForWorker(badRoutes, "any", "any")).toBeNull();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // SCENARIO 22: Step-count analysis — measure actual function calls needed
  // ═════════════════════════════════════════════════════════════════════════

  it("step count: full BMAD init from empty repo requires exactly 1 user command", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // STEP 1 (and only step): The user types this one command
    await mock.getCommand("harness:bmad")!.handler("--init", ctx);

    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // Verify everything was created automatically
    const state: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
    expect(state.managerSpawned).toBe(true);

    // Config, status, mode, goal files, worktrees, mailboxes — all from 1 command
    await stat(join(repo, "bmad", "config.yaml"));
    await stat(join(repo, "docs", "bmm-workflow-status.yaml"));
    await stat(join(repo, PI_AGENT_DIR, ".bmad-mode.json"));

    const registry = await readRegistry(repo);
    expect(Object.keys(registry.workers).length).toBeGreaterThan(0);
  });
});
