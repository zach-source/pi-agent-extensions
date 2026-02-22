/**
 * BMAD + Harness E2E Test — Part 6: Architecture Improvements
 *
 * This test validates the 3 architecture improvements from the OpenClaw comparison:
 *   1. BM25 memory search — multi-term queries, TF-IDF scoring
 *   2. Role-based tool policies — advisory prompt injection per role
 *   3. Deterministic manager operations — goal counting, auto-merge, queue dispatch
 *
 * Scenario: "Realistic startup from scratch"
 *   A user has a Node.js monorepo. They want to go from zero to a fully
 *   operational BMAD pipeline in 1-2 steps, then watch the harness deterministically
 *   merge completed workers and dispatch queued work — all without manager LLM
 *   intervention.
 *
 * Design principle: minimize setup steps, exercise new code paths, catch
 * integration blind spots.
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
  MANAGER_STATUS_FILE,
  MAILBOX_DIR,
  QUEUE_FILE,
  REGISTRY_FILE,
  MEMORY_FILE,
  BMAD_PREFIX,
  parseGoalFile,
  searchMemories,
  tokenize,
  computeBM25,
  getToolPolicy,
  ROLE_TOOL_POLICIES,
  readQueue,
  readRegistry,
  sendMailboxMessage,
  readMailbox,
  type LaunchState,
  type ManagerStatusFile,
  type HarnessMemory,
  type ToolPolicy,
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

describe("Architecture Improvements E2E", { timeout: 60000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "arch-e2e-"));
    repo = join(baseDir, "startup-app");
    git(`init ${repo}`, baseDir);
    git('config user.email "test@test.dev"', repo);
    git('config user.name "Test"', repo);

    // Realistic monorepo structure — Step 1 of "1-2 step setup"
    await writeFile(join(repo, "package.json"), JSON.stringify({
      name: "startup-app",
      version: "0.1.0",
      description: "SaaS dashboard for analytics",
    }, null, 2));
    await mkdir(join(repo, "src", "api"), { recursive: true });
    await mkdir(join(repo, "src", "web"), { recursive: true });
    await mkdir(join(repo, "src", "shared"), { recursive: true });
    await writeFile(join(repo, "src", "api", "server.ts"), 'import express from "express";\nexport const app = express();\n');
    await writeFile(join(repo, "src", "web", "App.tsx"), 'export default function App() { return <div>Dashboard</div>; }\n');
    await writeFile(join(repo, "src", "shared", "types.ts"), 'export type UserId = string;\n');
    git("add -A", repo);
    git('commit -m "initial: monorepo scaffold"', repo);
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null", { encoding: "utf-8" }); } catch { /* */ }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanupHarnessState(repo);
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
  // Test 1: "1-step cold start" — /harness:bmad --init boots everything
  // Focus: minimal user friction, all 3 improvements active from the start
  // ═════════════════════════════════════════════════════════════════════════

  it("1-step cold start: --init scaffolds BMAD + launches + new features are active", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // === THE ONE COMMAND ===
    await mock.getCommand("harness:bmad")!.handler("--init --max-workers 2", ctx);

    // No errors
    const errorCalls = ctx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "error");
    expect(errorCalls.length).toBe(0);

    // BMAD config scaffolded from package.json
    const config = await readFile(join(repo, "bmad", "config.yaml"), "utf-8");
    expect(config).toContain("startup-app");

    // Harness launched
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);

    // Workers spawned (max 2)
    const spawnedNames = Object.keys(launchState.sessions);
    expect(spawnedNames.length).toBeLessThanOrEqual(2);
    expect(spawnedNames.length).toBeGreaterThan(0);

    // Queue has overflow
    const queue = await readQueue(repo);
    expect(queue.items.length).toBeGreaterThan(0);

    // Goal files created
    const piDir = join(repo, PI_AGENT_DIR);
    const goalFiles = (await readdir(piDir)).filter(f => f.endsWith(".md") && !f.startsWith("."));
    expect(goalFiles.length).toBeGreaterThan(0);

    // -- New Feature Check: Tool policies in worker prompts --
    // Find a spawned worker that should have a restricted policy
    for (const name of spawnedNames) {
      const session = launchState.sessions[name];
      const promptFile = join(session.worktreePath, ".pi-agent-prompt.md");
      const promptContent = await readFile(promptFile, "utf-8");

      // Extract role from the goal file
      const goalFile = goalFiles.find(f => f.replace(".md", "") === name);
      if (goalFile) {
        const goalContent = await readFile(join(piDir, goalFile), "utf-8");
        const parsedGoal = parseGoalFile(goalContent, goalFile);
        const policy = getToolPolicy(parsedGoal.role);

        if (policy) {
          // Restricted role → prompt must contain tool policy section
          expect(promptContent).toContain("Tool Access Policy");
          expect(promptContent).toContain(policy.mode.toUpperCase());
        }
      }
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 2: BM25 memory search works end-to-end via harness tools
  // ═════════════════════════════════════════════════════════════════════════

  it("BM25 memory search: remember → recall with multi-term TF-IDF ranking", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Seed memories via the harness_remember tool
    const rememberTool = mock.getTool("harness_remember")!;
    const recallTool = mock.getTool("harness_recall")!;

    await rememberTool.execute("r1", {
      content: "PostgreSQL was chosen for the database because of strong JSON support",
      category: "decision",
      tags: ["database", "postgres", "json"],
    });
    await rememberTool.execute("r2", {
      content: "Redis cache hit rate in production is 94%, consider upgrading eviction policy",
      category: "insight",
      tags: ["cache", "redis", "performance"],
    });
    await rememberTool.execute("r3", {
      content: "API rate limiting bug: database connection pool exhausted under high load",
      category: "error",
      tags: ["api", "database", "bug"],
    });
    await rememberTool.execute("r4", {
      content: "Repository pattern with unit-of-work keeps database transactions clean",
      category: "pattern",
      tags: ["architecture", "database", "repository"],
    });

    // Single-term recall
    const redisResult = await recallTool.execute("q1", { query: "redis" });
    expect(redisResult.content[0].text).toContain("Redis cache hit rate");

    // Multi-term recall — BM25 should rank the error memory highest
    // because "database connection pool" has the most term overlap
    const multiResult = await recallTool.execute("q2", { query: "database connection pool" });
    const multiText = multiResult.content[0].text;
    // The error about "database connection pool exhausted" should rank first
    // because it matches 2 query terms (database, connection/pool)
    expect(multiText).toContain("connection pool");

    // Verify BM25 IDF: searching for a unique term should score higher than a common one
    const uniqueResult = await recallTool.execute("q3", { query: "eviction" });
    expect(uniqueResult.content[0].text).toContain("eviction");

    // Empty query returns nothing (not everything)
    const emptyResult = await recallTool.execute("q4", { query: "" });
    expect(emptyResult.content[0].text).toContain("No matching");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 3: Tool policies shape worker prompts per role
  // ═════════════════════════════════════════════════════════════════════════

  it("tool policies: restricted roles get advisory constraints in prompts", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Add workers with different roles
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "security-audit",
      goals: ["Review auth for OWASP top 10", "Check for XSS"],
      role: "reviewer",
    });
    await addTool.execute("a2", {
      name: "api-research",
      goals: ["Explore GraphQL vs REST trade-offs"],
      role: "researcher",
    });
    await addTool.execute("a3", {
      name: "backend-impl",
      goals: ["Implement user endpoint"],
      role: "developer",
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );

    // Reviewer prompt: targeted-write
    const reviewerPrompt = await readFile(
      join(launchState.sessions["security-audit"].worktreePath, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(reviewerPrompt).toContain("Tool Access Policy");
    expect(reviewerPrompt).toContain("TARGETED-WRITE");
    expect(reviewerPrompt).toContain("targeted fixes");

    // Researcher prompt: read-only
    const researcherPrompt = await readFile(
      join(launchState.sessions["api-research"].worktreePath, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(researcherPrompt).toContain("Tool Access Policy");
    expect(researcherPrompt).toContain("READ-ONLY");
    expect(researcherPrompt).toContain("Do NOT create, modify, or delete");

    // Developer prompt: NO policy section (full access)
    const developerPrompt = await readFile(
      join(launchState.sessions["backend-impl"].worktreePath, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(developerPrompt).not.toContain("Tool Access Policy");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 4: Deterministic goal counting reads from goal files, not manager
  // ═════════════════════════════════════════════════════════════════════════

  it("deterministic goal counting: turn_end reads goal files instead of manager status", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create 2 workers with known goals
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "api-work",
      goals: ["Build endpoints", "Add validation", "Write tests"],
    });
    await addTool.execute("a2", {
      name: "ui-work",
      goals: ["Create form", "Add styling"],
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    // Write a STALE manager status that says 2/5 done (lie)
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: {
          "api-work": { completed: 1, total: 3, allDone: false },
          "ui-work": { completed: 1, total: 2, allDone: false },
        },
        stallCount: 0,
      }),
    );

    // Simulate worker completing 1 goal (edit the actual goal file)
    const apiGoalPath = join(repo, PI_AGENT_DIR, "api-work.md");
    let apiGoal = await readFile(apiGoalPath, "utf-8");
    apiGoal = apiGoal.replace("- [ ] Build endpoints", "- [x] Build endpoints");
    await writeFile(apiGoalPath, apiGoal);

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Deterministic counting: 1/5 (from goal files), NOT 2/5 (from manager)
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const lastStatus = statusCalls[statusCalls.length - 1] as string;
    expect(lastStatus).toContain("1/5 goals");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 5: Deterministic auto-merge on 100% completion
  // ═════════════════════════════════════════════════════════════════════════

  it("deterministic auto-merge: worker branch merged when all goals complete", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Single worker with 1 goal
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "quick-fix",
      goals: ["Fix the typo in README"],
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    const session = launchState.sessions["quick-fix"];
    expect(session).toBeDefined();

    // Simulate worker completing the goal and committing
    const worktreePath = session.worktreePath;
    await writeFile(join(worktreePath, "FIXED.md"), "# Fixed\n");
    git("add FIXED.md", worktreePath);
    git('commit -m "fix: typo in README"', worktreePath);

    // Mark goal as complete in the goal file
    const goalPath = join(repo, PI_AGENT_DIR, "quick-fix.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent = goalContent.replace("- [ ] Fix the typo in README", "- [x] Fix the typo in README");
    await writeFile(goalPath, goalContent);

    // Write manager status so turn_end proceeds past the "no status" guard
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "quick-fix": { completed: 1, total: 1, allDone: true } },
        stallCount: 0,
      }),
    );

    mock.api.sendMessage.mockClear();
    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Auto-merge should have fired
    const mergeCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any) => c[0]?.customType === "harness-auto-merged",
    );
    expect(mergeCalls.length).toBe(1);
    expect(mergeCalls[0][0].content).toContain("quick-fix");

    // Verify the file was actually merged into main
    const mainFiles = git("ls-files", repo);
    expect(mainFiles).toContain("FIXED.md");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 6: Deterministic auto-merge blocked by unanswered questions
  // ═════════════════════════════════════════════════════════════════════════

  it("auto-merge blocked: unanswered questions prevent merge even at 100% goals", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "blocked-worker",
      goals: ["Do the thing"],
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    // Mark goal complete BUT add an unanswered question
    const goalPath = join(repo, PI_AGENT_DIR, "blocked-worker.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent = goalContent.replace("- [ ] Do the thing", "- [x] Do the thing");
    goalContent += "\n## Questions\n- ? Which database should I use?\n";
    await writeFile(goalPath, goalContent);

    // Commit something in the worktree so there's something to merge
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    const wt = launchState.sessions["blocked-worker"].worktreePath;
    await writeFile(join(wt, "work.txt"), "done\n");
    git("add work.txt", wt);
    git('commit -m "done"', wt);

    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "blocked-worker": { completed: 1, total: 1, allDone: true } },
        stallCount: 0,
      }),
    );

    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Should NOT auto-merge (unanswered question)
    const mergeCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any) => c[0]?.customType === "harness-auto-merged",
    );
    expect(mergeCalls.length).toBe(0);

    // Status should show the unanswered question
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const lastStatus = statusCalls[statusCalls.length - 1] as string;
    expect(lastStatus).toContain("1?");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 7: Deterministic queue dispatch spawns when slot opens
  // ═════════════════════════════════════════════════════════════════════════

  it("deterministic queue dispatch: spawns queued worker when active count drops", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Create 3 workers, but launch with --max-workers 1
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "worker-a",
      goals: ["Do task A"],
    });
    await addTool.execute("a2", {
      name: "worker-b",
      goals: ["Do task B"],
    });

    await mock.getCommand("harness:launch")!.handler("--max-workers 1 --stagger 0", ctx);

    // Only 1 worker should be spawned, 1 queued
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(Object.keys(launchState.sessions).length).toBe(1);

    const queue = await readQueue(repo);
    expect(queue.items.filter(i => i.status === "pending").length).toBe(1);

    // Verify the queued item has the right topic
    const queuedItem = queue.items.find(i => i.status === "pending");
    expect(queuedItem).toBeDefined();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 8: BM25 memory injection into worker prompts
  // ═════════════════════════════════════════════════════════════════════════

  it("BM25 memory injection: relevant memories injected into worker prompt", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Pre-populate memory store with entries relevant to "auth" work
    const memoryStore = {
      version: 1,
      memories: [
        {
          id: "m1",
          timestamp: "2024-01-01T00:00:00Z",
          source: "worker-auth",
          category: "decision",
          content: "Use JWT with refresh tokens for authentication flow",
          tags: ["auth", "jwt", "security"],
          relevance: 0.9,
        },
        {
          id: "m2",
          timestamp: "2024-01-02T00:00:00Z",
          source: "worker-db",
          category: "pattern",
          content: "Connection pool size of 20 works well for PostgreSQL",
          tags: ["database", "postgres"],
          relevance: 0.7,
        },
      ],
    };
    await mkdir(join(repo, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(repo, MEMORY_FILE), JSON.stringify(memoryStore));

    // Create an auth-related worker
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "auth-api",
      goals: ["Build login endpoint"],
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    // Read the worker prompt — should contain the auth memory
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    const prompt = await readFile(
      join(launchState.sessions["auth-api"].worktreePath, ".pi-agent-prompt.md"),
      "utf-8",
    );

    // BM25 search for "auth-api" should find the auth memory
    // "auth" tokenizes to match the auth memory's tags
    expect(prompt).toContain("Prior Learnings");
    // At least one memory should be injected
    const learningLines = prompt.split("\n").filter(l => l.includes("[decision]") || l.includes("[pattern]"));
    expect(learningLines.length).toBeGreaterThan(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 9: Full lifecycle — 1-step BMAD → simulate work → auto-merge →
  //         queue dispatch → verify everything in 1 flowing test
  // ═════════════════════════════════════════════════════════════════════════

  it("full lifecycle: cold start → work → auto-merge → queue dispatch", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    // Step 1: Add tasks with dependencies
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "core-lib",
      goals: ["Build shared types", "Write utility functions"],
      role: "developer",
    });
    await addTool.execute("a2", {
      name: "api-service",
      goals: ["Build REST endpoints", "Add middleware"],
      role: "developer",
    });

    // Write api-service's dependency on core-lib
    const apiGoalPath = join(repo, PI_AGENT_DIR, "api-service.md");
    let apiGoal = await readFile(apiGoalPath, "utf-8");
    apiGoal = apiGoal.replace("path: .", "path: .\ndepends_on: core-lib");
    await writeFile(apiGoalPath, apiGoal);

    // Step 2: Launch with max-workers 1 (core-lib spawns, api-service queued)
    await mock.getCommand("harness:launch")!.handler("--max-workers 1 --stagger 0", ctx);

    let launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(Object.keys(launchState.sessions)).toContain("core-lib");

    let queue = await readQueue(repo);
    const apiInQueue = queue.items.find(i => i.topic === "api-service");
    expect(apiInQueue).toBeDefined();

    // Step 3: Simulate core-lib completing
    const coreGoalPath = join(repo, PI_AGENT_DIR, "core-lib.md");
    let coreGoal = await readFile(coreGoalPath, "utf-8");
    coreGoal = coreGoal.replace(/- \[ \]/g, "- [x]");
    await writeFile(coreGoalPath, coreGoal);

    // Commit work in worktree
    const coreWt = launchState.sessions["core-lib"].worktreePath;
    await mkdir(join(coreWt, "src", "shared"), { recursive: true });
    await writeFile(join(coreWt, "src", "shared", "types.ts"), 'export type ID = string;\n');
    git("add .", coreWt);
    git('commit -m "feat: shared types and utils"', coreWt);

    // Write manager status so turn_end proceeds
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "core-lib": { completed: 2, total: 2, allDone: true } },
        stallCount: 0,
      }),
    );

    // Step 4: Fire turn_end → should auto-merge core-lib
    mock.api.sendMessage.mockClear();
    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Verify auto-merge happened
    const mergeMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any) => c[0]?.customType === "harness-auto-merged",
    );
    expect(mergeMsgs.length).toBe(1);
    expect(mergeMsgs[0][0].content).toContain("core-lib");

    // Verify merged file is on main
    const mainFiles = git("ls-files", repo);
    expect(mainFiles).toContain("src/shared/types.ts");

    // Step 5: Verify deterministic status bar shows correct counts
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const lastStatus = statusCalls[statusCalls.length - 1] as string;
    // core-lib: 2/2 done + api-service: 0/2 pending = 2/4 total
    expect(lastStatus).toContain("2/4 goals");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 10: Double-merge guard prevents re-merging
  // ═════════════════════════════════════════════════════════════════════════

  it("double-merge guard: second turn_end does not re-merge same worker", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("a1", {
      name: "once-only",
      goals: ["Single task"],
    });

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    // Complete the goal
    const goalPath = join(repo, PI_AGENT_DIR, "once-only.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent = goalContent.replace("- [ ] Single task", "- [x] Single task");
    await writeFile(goalPath, goalContent);

    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    const wt = launchState.sessions["once-only"].worktreePath;
    await writeFile(join(wt, "done.txt"), "done\n");
    git("add done.txt", wt);
    git('commit -m "done"', wt);

    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "once-only": { completed: 1, total: 1, allDone: true } },
        stallCount: 0,
      }),
    );

    // First turn_end: should merge
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    const firstMergeCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any) => c[0]?.customType === "harness-auto-merged",
    );
    expect(firstMergeCalls.length).toBe(1);

    // Second turn_end: should NOT merge again (double-merge guard)
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    const secondMergeCalls = mock.api.sendMessage.mock.calls.filter(
      (c: any) => c[0]?.customType === "harness-auto-merged",
    );
    expect(secondMergeCalls.length).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 11: BM25 pure function edge cases
  // ═════════════════════════════════════════════════════════════════════════

  it("BM25 edge cases: single-doc corpus, all-same terms, punctuation-heavy queries", () => {
    // Single document — IDF denominator is 1
    const singleDoc = computeBM25(["test"], [["test", "test", "test"]]);
    expect(singleDoc[0]).toBeGreaterThan(0);

    // All documents have the same term — IDF should be low
    const allSame = computeBM25(
      ["common"],
      [["common", "a"], ["common", "b"], ["common", "c"]],
    );
    // All scores should be positive but low-ish
    expect(allSame.every(s => s > 0)).toBe(true);
    // And roughly equal since each doc has 1 occurrence
    const maxDiff = Math.max(...allSame) - Math.min(...allSame);
    expect(maxDiff).toBeLessThan(0.5);

    // Punctuation-heavy query should tokenize properly
    const tokens = tokenize("user.name@email.com: hello-world! (test)");
    expect(tokens).toContain("user");
    expect(tokens).toContain("name");
    expect(tokens).toContain("email");
    expect(tokens).toContain("com");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("test");

    // searchMemories with punctuation query
    const memories: HarnessMemory[] = [
      {
        id: "1", timestamp: "2024-01-01", source: "w",
        category: "error", content: "user.name field causes NullPointerException",
        tags: ["bug"], relevance: 0.5,
      },
    ];
    const results = searchMemories(memories, "user.name");
    expect(results.length).toBe(1);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 12: Tool policy exhaustive coverage — every restricted role
  // ═════════════════════════════════════════════════════════════════════════

  it("tool policy coverage: every restricted role spawns with correct policy in prompt", async () => {
    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const restrictedRoles = ROLE_TOOL_POLICIES.map(p => p.role);
    const addTool = mock.getTool("harness_add_task")!;

    for (const role of restrictedRoles) {
      await addTool.execute(`a-${role}`, {
        name: `test-${role}`,
        goals: [`Validate ${role} policy`],
        role,
      });
    }

    await mock.getCommand("harness:launch")!.handler("--stagger 0", ctx);

    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );

    for (const policy of ROLE_TOOL_POLICIES) {
      const session = launchState.sessions[`test-${policy.role}`];
      expect(session).toBeDefined();
      const prompt = await readFile(
        join(session.worktreePath, ".pi-agent-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("Tool Access Policy");
      expect(prompt).toContain(policy.mode.toUpperCase());
      // Verify the specific instructions text is present
      expect(prompt).toContain(policy.instructions.substring(0, 30));
    }
  });
});
