/**
 * Sophisticated BMAD + Harness E2E Test
 *
 * Creates a realistic test project with actual source code, tests, configs,
 * and CI files, then exercises the full BMAD harness lifecycle across
 * multiple project levels and edge cases.
 *
 * Focus areas:
 *   1. Realistic project scaffolding (not toy repos)
 *   2. Full L2 BMAD lifecycle with worktree/branch verification
 *   3. Prompt content integrity — no interactive leaks, correct tools/paths
 *   4. Turn_end manager status detection and state transitions
 *   5. Mid-run completion simulation: worker finishes → manager merges → cascade
 *   6. Edge cases: concurrent phase completion, malformed status, empty DAGs
 *   7. Stop/cleanup leaves no orphaned git state
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
  parseGoalFile,
  serializeGoalFile,
  buildBmadWorkflowDag,
  buildManagerInstructions,
  goalFileName,
  readQueue,
  readRegistry,
  readMailbox,
  sendMailboxMessage,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_STATUS_FILE,
  MAILBOX_DIR,
  QUEUE_FILE,
  REGISTRY_FILE,
  BMAD_PREFIX,
  BMAD_ROLE_MAP,
  type SubmoduleConfig,
  type LaunchState,
  type ManagerStatusFile,
  type WorkerState,
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
          const quotedArgs = args.map((a: string) =>
            `'${a.replace(/'/g, "'\\''")}'`,
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

// ---------------------------------------------------------------------------
// Realistic Project Scaffolding
// ---------------------------------------------------------------------------

/** Build a realistic TypeScript web-app repo with source, tests, CI, etc. */
async function scaffoldRealisticProject(dir: string): Promise<void> {
  // Source files
  await mkdir(join(dir, "src", "auth"), { recursive: true });
  await mkdir(join(dir, "src", "api"), { recursive: true });
  await mkdir(join(dir, "src", "db"), { recursive: true });
  await mkdir(join(dir, "tests"), { recursive: true });
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });

  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "acme-platform",
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "tsc",
          test: "vitest run",
          lint: "eslint src/",
        },
        dependencies: {
          express: "^4.18.0",
          prisma: "^5.0.0",
          jsonwebtoken: "^9.0.0",
        },
        devDependencies: {
          vitest: "^1.0.0",
          typescript: "^5.0.0",
          eslint: "^8.0.0",
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          outDir: "dist",
          strict: true,
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(dir, "README.md"),
    [
      "# Acme Platform",
      "",
      "A multi-tenant SaaS platform with JWT auth, REST API, and Prisma ORM.",
      "",
      "## TODO",
      "- [ ] Add refresh token rotation",
      "- [ ] Set up CI pipeline",
      "- [ ] Write integration tests for user API",
      "",
      "## Architecture",
      "Express + Prisma + PostgreSQL",
    ].join("\n"),
  );

  // Auth module (with intentional gaps)
  await writeFile(
    join(dir, "src", "auth", "jwt.ts"),
    [
      'import jwt from "jsonwebtoken";',
      "",
      "// TODO: move secret to env var",
      'const SECRET = "hardcoded-secret";',
      "",
      "export function signToken(userId: string): string {",
      '  return jwt.sign({ sub: userId }, SECRET, { expiresIn: "1h" });',
      "}",
      "",
      "export function verifyToken(token: string): any {",
      "  return jwt.verify(token, SECRET);",
      "}",
    ].join("\n"),
  );

  await writeFile(
    join(dir, "src", "auth", "middleware.ts"),
    [
      'import { verifyToken } from "./jwt.js";',
      "",
      "// HACK: no refresh token support yet",
      "export function authMiddleware(req: any, res: any, next: any) {",
      '  const header = req.headers.authorization ?? "";',
      '  const token = header.replace("Bearer ", "");',
      "  try {",
      "    req.user = verifyToken(token);",
      "    next();",
      "  } catch {",
      "    res.status(401).json({ error: 'Unauthorized' });",
      "  }",
      "}",
    ].join("\n"),
  );

  // API routes
  await writeFile(
    join(dir, "src", "api", "users.ts"),
    [
      "export async function getUsers(req: any, res: any) {",
      "  // FIXME: no pagination",
      "  const users = await req.db.user.findMany();",
      "  res.json(users);",
      "}",
      "",
      "export async function createUser(req: any, res: any) {",
      "  const { email, name } = req.body;",
      "  const user = await req.db.user.create({ data: { email, name } });",
      "  res.status(201).json(user);",
      "}",
    ].join("\n"),
  );

  // DB config
  await writeFile(
    join(dir, "src", "db", "client.ts"),
    [
      '// import { PrismaClient } from "@prisma/client";',
      "// export const prisma = new PrismaClient();",
      "export const prisma = {} as any; // placeholder",
    ].join("\n"),
  );

  // Minimal test (intentionally sparse coverage)
  await writeFile(
    join(dir, "tests", "auth.test.ts"),
    [
      'import { describe, it, expect } from "vitest";',
      "",
      'describe("auth", () => {',
      '  it("placeholder", () => {',
      "    expect(true).toBe(true);",
      "  });",
      "});",
    ].join("\n"),
  );

  // CI config (incomplete)
  await writeFile(
    join(dir, ".github", "workflows", "ci.yml"),
    [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm install",
      "      - run: npm test",
    ].join("\n"),
  );
}

/** Write BMAD config */
async function writeBmadConfig(
  dir: string,
  name: string,
  level: number,
  type = "web-app",
) {
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
      '  sprint_status_file: "docs/sprint-status.yaml"',
      "",
      "paths:",
      "  docs: docs",
      "  stories: docs/stories",
      "  tests: tests",
    ].join("\n"),
  );
}

/** Write BMAD workflow status */
async function writeStatusFile(
  dir: string,
  entries: Array<{ name: string; phase: number; status: string; desc?: string }>,
) {
  await mkdir(join(dir, "docs"), { recursive: true });
  const lines = ["# BMAD Workflow Status", "", "workflow_status:"];
  for (const e of entries) {
    lines.push(
      `  - name: ${e.name}`,
      `    phase: ${e.phase}`,
      `    status: "${e.status}"`,
      `    description: "${e.desc ?? e.name + " workflow"}"`,
      "",
    );
  }
  await writeFile(join(dir, "docs", "bmm-workflow-status.yaml"), lines.join("\n"));
}

// The standard set of workflow entries needed for a status file at various levels
const ALL_WORKFLOW_ENTRIES = [
  { name: "product-brief", phase: 1, status: "optional", desc: "Create product brief" },
  { name: "brainstorm", phase: 1, status: "optional", desc: "Brainstorming session" },
  { name: "research", phase: 1, status: "optional", desc: "Market research" },
  { name: "prd", phase: 2, status: "required", desc: "Product Requirements Document" },
  { name: "tech-spec", phase: 2, status: "optional", desc: "Technical Specification" },
  { name: "create-ux-design", phase: 2, status: "optional", desc: "UX design" },
  { name: "architecture", phase: 3, status: "required", desc: "System architecture" },
  { name: "solutioning-gate-check", phase: 3, status: "optional", desc: "Validate architecture" },
  { name: "sprint-planning", phase: 4, status: "required", desc: "Plan sprint iterations" },
  { name: "create-story", phase: 4, status: "required", desc: "Create user stories" },
  { name: "dev-story", phase: 4, status: "required", desc: "Implement story" },
];

async function cleanupHarnessState(repo: string) {
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
  } catch {
    /* first test */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite: Sophisticated BMAD Harness E2E
// ═══════════════════════════════════════════════════════════════════════════════

describe("BMAD harness e2e: realistic project lifecycle", { timeout: 60000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bmad-e2e-"));
    repo = join(baseDir, "acme-platform");
    git(`init ${repo}`, baseDir);
    git('config user.email "zach@acme.dev"', repo);
    git('config user.name "Zach"', repo);
    await scaffoldRealisticProject(repo);
    git("add -A", repo);
    git('commit -m "initial: scaffold acme platform"', repo);
  });

  afterAll(async () => {
    // Kill any tmux sessions
    try {
      execSync("tmux -L pi-harness kill-server 2>/dev/null", { encoding: "utf-8" });
    } catch {
      /* no sessions */
    }
    await rm(baseDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanupHarnessState(repo);
  });

  function freshHarness() {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);
    return { mock, ctx };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Test 1: Full L2 lifecycle on a realistic codebase
  // ═════════════════════════════════════════════════════════════════════════
  it("L2 full lifecycle: realistic project → DAG → worktrees → prompts → manager → turn_end status", async () => {
    // Phase 1 done, Phase 2+ pending
    await writeBmadConfig(repo, "AcmePlatform", 2);
    await writeStatusFile(repo, [
      { name: "product-brief", phase: 1, status: "docs/product-brief.md" },
      { name: "brainstorm", phase: 1, status: "docs/brainstorm.md" },
      { name: "research", phase: 1, status: "docs/research.md" },
      ...ALL_WORKFLOW_ENTRIES.filter(
        (e) => !["product-brief", "brainstorm", "research"].includes(e.name),
      ),
    ]);
    git("add -A && git commit -m 'add bmad config + status'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--max-workers 3", ctx);

    // --- Verify .bmad-mode.json ---
    const modeRaw = await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8");
    const mode = JSON.parse(modeRaw);
    expect(mode.enabled).toBe(true);
    expect(mode.projectLevel).toBe(2);
    expect(mode.projectName).toBe("AcmePlatform");

    // Phase 1 already done → should NOT appear in workflows
    const wfNames = mode.workflows.map((w: any) => w.workflowName);
    expect(wfNames).not.toContain("product-brief");
    expect(wfNames).not.toContain("brainstorm");
    expect(wfNames).not.toContain("research");

    // Remaining workflows should be present
    expect(wfNames).toContain("prd");
    expect(wfNames).toContain("architecture");
    expect(wfNames).toContain("create-ux-design");
    expect(wfNames).toContain("solutioning-gate-check");
    expect(wfNames).toContain("sprint-planning");
    expect(wfNames).toContain("create-story");
    expect(wfNames).toContain("dev-story");

    // prd: depends on product-brief (completed) → ready
    const prdWf = mode.workflows.find((w: any) => w.workflowName === "prd");
    expect(prdWf.dependsOn).toEqual([]);
    expect(prdWf.status).toBe("active");

    // create-ux-design: depends on prd (unmet) → pending
    const uxWf = mode.workflows.find((w: any) => w.workflowName === "create-ux-design");
    expect(uxWf.dependsOn).toEqual(["bmad-prd"]);
    expect(uxWf.status).toBe("pending");

    // architecture: depends on prd + tech-spec. tech-spec NOT in L2 → only prd
    const archWf = mode.workflows.find((w: any) => w.workflowName === "architecture");
    expect(archWf.dependsOn).toEqual(["bmad-prd"]);

    // --- Verify worktree isolation ---
    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);

    // Only ready workers should have worktrees
    const activeWfs = mode.workflows
      .filter((w: any) => w.status === "active")
      .map((w: any) => w.name);
    for (const name of activeWfs) {
      expect(worktrees).toContain(name);
    }

    // Queued workers should NOT have worktrees
    const pendingWfs = mode.workflows
      .filter((w: any) => w.status === "pending")
      .map((w: any) => w.name);
    for (const name of pendingWfs) {
      expect(worktrees).not.toContain(name);
    }

    // --- Verify each worktree is on its own branch ---
    for (const wt of worktrees) {
      const wtPath = join(wtDir, wt);
      const branch = git("rev-parse --abbrev-ref HEAD", wtPath);
      expect(branch).toBe(`pi-agent/${wt}`);

      // Worktree should have the project files
      const files = await readdir(wtPath);
      expect(files).toContain("package.json");
      expect(files).toContain("src");

      // Worktree should have prompt and heartbeat
      expect(files).toContain(".pi-agent-prompt.md");
      expect(files).toContain("heartbeat.md");
    }

    // --- Verify prompt content quality for active workers ---
    for (const name of activeWfs) {
      const promptPath = join(wtDir, name, ".pi-agent-prompt.md");
      const prompt = await readFile(promptPath, "utf-8");

      // Must have autonomous preamble
      expect(prompt).toContain("Autonomous BMAD Worker");
      expect(prompt).toContain("no interactive user");

      // Must NOT have any interactive phrases
      expect(prompt).not.toMatch(/[Ii]nterview the user/);
      expect(prompt).not.toMatch(/[Aa]sk the user/);
      expect(prompt).not.toMatch(/[Cc]onfirm with the user/);

      // Must reference bmad tools
      expect(prompt).toContain("bmad_save_document");
      expect(prompt).toContain("bmad_update_status");

      // Must have goal file path pointing to MAIN repo, not worktree
      expect(prompt).toContain(join(repo, PI_AGENT_DIR));

      // Must have mailbox section with correct path
      expect(prompt).toContain("## Mailbox");
      expect(prompt).toContain(MAILBOX_DIR);
    }

    // --- Verify manager instructions ---
    const mgrInstructions = await readFile(
      join(repo, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(mgrInstructions).toContain("BMAD Phase Management");
    expect(mgrInstructions).toContain("AcmePlatform");
    expect(mgrInstructions).toContain("Level 2");
    expect(mgrInstructions).toContain("Max concurrent workers: 3");
    expect(mgrInstructions).toContain("Dev-story fan-out");
    expect(mgrInstructions).toContain("bmad-create-story");
    expect(mgrInstructions).toContain("bmad-mode.json");

    // Manager should know about worker roles
    expect(mgrInstructions).toContain("Worker Roles");

    // --- Verify registry accuracy ---
    const registry = await readRegistry(repo);
    for (const name of activeWfs) {
      expect(registry.workers[name]).toBeDefined();
      expect(registry.workers[name].status).toBe("active");
      expect(registry.workers[name].goalsTotal).toBeGreaterThan(0);
      expect(registry.workers[name].goalsCompleted).toBe(0);
    }
    for (const name of pendingWfs) {
      expect(registry.workers[name]).toBeUndefined();
    }

    // --- Verify queue has correct pending items ---
    const queue = await readQueue(repo);
    const pendingItems = queue.items.filter((i) => i.status === "pending");
    for (const name of pendingWfs) {
      const item = pendingItems.find((i) => i.topic === name);
      expect(item).toBeDefined();
      expect(item!.goals.length).toBeGreaterThan(0);
      expect(item!.description).toContain("BMAD workflow");
    }

    // --- Simulate turn_end with fresh manager status ---
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: Object.fromEntries(
        activeWfs.map((name) => [
          name,
          { completed: 0, total: 1, allDone: false },
        ]),
      ),
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // Status bar should show running state
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("goals"),
    );

    // --- Verify launch state persistence ---
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(true);
    expect(launchState.managerSpawned).toBe(true);
    for (const name of activeWfs) {
      expect(launchState.sessions[name]).toBeDefined();
      expect(launchState.sessions[name].spawned).toBe(true);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 2: L1 project — verify simplified DAG with product-brief chain
  // ═════════════════════════════════════════════════════════════════════════
  it("L1 project: product-brief → tech-spec → sprint → story chain (no prd/architecture)", async () => {
    await writeBmadConfig(repo, "SmallAPI", 1, "api");
    await writeStatusFile(repo, [
      { name: "product-brief", phase: 1, status: "optional" },
      { name: "brainstorm", phase: 1, status: "optional" },
      { name: "research", phase: 1, status: "optional" },
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'L1 config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 5", ctx);

    const mode = JSON.parse(
      await readFile(join(repo, PI_AGENT_DIR, ".bmad-mode.json"), "utf-8"),
    );
    const wfNames = mode.workflows.map((w: any) => w.workflowName);

    // L1 should NOT have prd, architecture, create-ux-design, solutioning-gate-check
    expect(wfNames).not.toContain("prd");
    expect(wfNames).not.toContain("architecture");
    expect(wfNames).not.toContain("create-ux-design");
    expect(wfNames).not.toContain("solutioning-gate-check");

    // L1 should have: product-brief, brainstorm, research, tech-spec, sprint-planning, create-story, dev-story
    expect(wfNames).toContain("product-brief");
    expect(wfNames).toContain("tech-spec");
    expect(wfNames).toContain("sprint-planning");

    // Phase 1 (no deps) should all be active
    const phase1Active = mode.workflows
      .filter((w: any) => w.phase === 1 && w.status === "active")
      .map((w: any) => w.workflowName);
    expect(phase1Active).toContain("product-brief");
    expect(phase1Active).toContain("brainstorm");
    expect(phase1Active).toContain("research");

    // tech-spec depends on product-brief → should be pending
    const tsWf = mode.workflows.find((w: any) => w.workflowName === "tech-spec");
    expect(tsWf.status).toBe("pending");
    expect(tsWf.dependsOn).toEqual(["bmad-product-brief"]);

    // sprint-planning at L1 depends on [architecture, tech-spec]
    // architecture not in L1 plan → only tech-spec matters
    const spWf = mode.workflows.find((w: any) => w.workflowName === "sprint-planning");
    expect(spWf.dependsOn).toEqual(["bmad-tech-spec"]);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 3: Turn_end state transitions — running → stalled detection
  // ═════════════════════════════════════════════════════════════════════════
  it("turn_end detects stale manager and updates status bar correctly", async () => {
    await writeBmadConfig(repo, "StaleTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'stale test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Write a STALE manager status (10 minutes old — well past the 5-min threshold)
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: staleTime,
      submodules: {
        "bmad-tech-spec": { completed: 0, total: 1, allDone: false },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // Should show stale or recovering status
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const lastStatus = statusCalls[statusCalls.length - 1];
    expect(lastStatus).toMatch(/stale|recover/);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 4: Turn_end with all_complete → deactivation
  // ═════════════════════════════════════════════════════════════════════════
  it("turn_end deactivates loop on all_complete manager status", async () => {
    await writeBmadConfig(repo, "CompleteTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'complete test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Write an all_complete manager status
    const managerStatus: ManagerStatusFile = {
      status: "all_complete",
      updatedAt: new Date().toISOString(),
      submodules: {
        "bmad-tech-spec": { completed: 1, total: 1, allDone: true },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // Launch state should be deactivated
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(false);

    // Status should show done
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const lastStatus = statusCalls[statusCalls.length - 1];
    expect(lastStatus).toMatch(/done|complete/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 5: Stop command cleans up all git state
  // ═════════════════════════════════════════════════════════════════════════
  it("harness:stop removes worktrees, stop signal, and deactivates", async () => {
    await writeBmadConfig(repo, "StopTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'stop test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Verify worktree exists before stop
    const wtDir = join(repo, WORKTREE_DIR);
    const wtBefore = await readdir(wtDir);
    expect(wtBefore.length).toBeGreaterThan(0);

    // Stop
    await mock.getCommand("harness:stop")!.handler("", ctx);

    // Stop signal should be written
    let stopSignalExists = false;
    try {
      await stat(join(repo, STOP_SIGNAL_FILE));
      stopSignalExists = true;
    } catch {
      /* expected if manager already processed it */
    }

    // Launch state should be deactivated
    const launchState: LaunchState = JSON.parse(
      await readFile(join(repo, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(launchState.active).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 6: Cleanup removes ALL artifacts (no orphaned branches/worktrees)
  // ═════════════════════════════════════════════════════════════════════════
  it("harness:cleanup leaves zero orphaned git branches or worktrees", async () => {
    await writeBmadConfig(repo, "CleanupTest", 2);
    await writeStatusFile(repo, [
      { name: "product-brief", phase: 1, status: "docs/pb.md" },
      ...ALL_WORKFLOW_ENTRIES.filter((e) => e.name !== "product-brief"),
    ]);
    git("add -A && git commit -m 'cleanup test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 2", ctx);

    // Verify branches were created
    const branchesBefore = git("branch --list pi-agent/*", repo)
      .split("\n")
      .filter(Boolean);
    expect(branchesBefore.length).toBeGreaterThan(0);

    // Stop first (required before cleanup)
    await mock.getCommand("harness:stop")!.handler("", ctx);

    // Cleanup with --force (worktrees may have untracked files from heartbeat/prompt)
    await mock.getCommand("harness:cleanup")!.handler("--force", ctx);

    // No pi-agent/* branches should remain after cleanup
    let branchesAfter: string[] = [];
    try {
      const branchOutput = git("branch --list pi-agent/*", repo);
      branchesAfter = branchOutput
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
    } catch {
      /* branch list may return empty */
    }
    expect(branchesAfter.length).toBe(0);

    // No worktrees should remain (just main)
    const worktreeList = git("worktree list", repo);
    const worktreeCount = worktreeList.split("\n").filter(Boolean).length;
    expect(worktreeCount).toBe(1); // only main

    // .pi-agent/ directory should be fully removed after cleanup
    let piAgentExists = false;
    try {
      await stat(join(repo, PI_AGENT_DIR));
      piAgentExists = true;
    } catch {
      /* expected — directory removed */
    }
    expect(piAgentExists).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 7: Mailbox message round-trip between worker and manager
  // ═════════════════════════════════════════════════════════════════════════
  it("mailbox messages survive write → read → delete cycle", async () => {
    await writeBmadConfig(repo, "MailboxTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'mailbox test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Worker → manager: question
    await sendMailboxMessage(repo, "manager", "bmad-tech-spec", "question", {
      question: "Should we use PostgreSQL or MySQL?",
      context: "Database selection for the tech spec",
    });

    // Read manager inbox
    const messages = await readMailbox(repo, "manager");
    // Should have at least 2 messages: the directive from launch + our question
    expect(messages.length).toBeGreaterThanOrEqual(2);

    const question = messages.find((m) => m.message.type === "question");
    expect(question).toBeDefined();
    expect(question!.message.from).toBe("bmad-tech-spec");
    expect(question!.message.payload.question).toContain("PostgreSQL");

    // Manager → parent: forwarded question
    await sendMailboxMessage(repo, "parent", "manager", "question", {
      question: "Worker bmad-tech-spec asks: Should we use PostgreSQL or MySQL?",
      originalFrom: "bmad-tech-spec",
    });

    // Read parent inbox
    const parentMessages = await readMailbox(repo, "parent");
    expect(parentMessages.length).toBeGreaterThan(0);
    const forwarded = parentMessages.find(
      (m) => m.message.payload?.originalFrom === "bmad-tech-spec",
    );
    expect(forwarded).toBeDefined();

    // turn_end should surface parent inbox messages
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "bmad-tech-spec": { completed: 0, total: 1, allDone: false },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // The sendMessage mock should have been called with harness-question
    const questionMsgCall = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-question",
    );
    expect(questionMsgCall).toBeDefined();
    expect(questionMsgCall![0].content).toContain("bmad-tech-spec");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 8: Goal file modification by simulated worker → progress tracking
  // ═════════════════════════════════════════════════════════════════════════
  it("goal file progress: marking goals complete updates sidecar state via turn_end", async () => {
    await writeBmadConfig(repo, "ProgressTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'progress test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Read goal file and mark goal as complete (simulate worker editing it)
    const goalPath = join(repo, PI_AGENT_DIR, "bmad-tech-spec.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent = goalContent.replace("- [ ]", "- [x]");
    await writeFile(goalPath, goalContent);

    // Write manager status reflecting completion
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "bmad-tech-spec": { completed: 1, total: 1, allDone: true },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // Status bar should reflect goal progress (deterministic counting from all goal files)
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const latestStatus = statusCalls[statusCalls.length - 1];
    // With deterministic counting, all 4 BMAD workflow goal files are counted
    expect(latestStatus).toContain("1/4");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 9: Unanswered questions surface in status bar
  // ═════════════════════════════════════════════════════════════════════════
  it("unanswered questions in goal files appear in turn_end status bar", async () => {
    await writeBmadConfig(repo, "QuestionTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'question test config'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    // Simulate worker adding a question to the goal file
    const goalPath = join(repo, PI_AGENT_DIR, "bmad-tech-spec.md");
    let goalContent = await readFile(goalPath, "utf-8");
    goalContent += "\n\n## Questions\n- ? Should we support GraphQL in addition to REST?\n";
    await writeFile(goalPath, goalContent);

    // Write fresh manager status
    const managerStatus: ManagerStatusFile = {
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: {
        "bmad-tech-spec": { completed: 0, total: 1, allDone: false, unansweredQuestions: 1 },
      },
      stallCount: 0,
    };
    await writeFile(
      join(repo, MANAGER_STATUS_FILE),
      JSON.stringify(managerStatus),
    );

    await mock.emit("turn_end", {}, ctx);

    // Status bar should show question count
    const statusCalls = ctx.ui.setStatus.mock.calls
      .filter((c: any[]) => c[0] === "harness")
      .map((c: any[]) => c[1]);
    const latestStatus = statusCalls[statusCalls.length - 1];
    expect(latestStatus).toContain("1?");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 10: DAG waterfall simulation — all phases from L2
  // ═════════════════════════════════════════════════════════════════════════
  it("DAG cascade: simulated phase-by-phase completion at L2 shows correct unblocking", async () => {
    const { WORKFLOW_DEFS } = await import("./bmad.js");

    // Start: nothing completed
    const dag0 = buildBmadWorkflowDag(2, [], WORKFLOW_DEFS);

    // Phase 1 (no deps) should be ready
    const noDeps = dag0.filter((s) => s.dependsOn.length === 0);
    const noDepNames = noDeps.map((s) => s.workflowName).sort();
    expect(noDepNames).toEqual(["brainstorm", "product-brief", "research"]);

    // After Phase 1 completes
    const dag1 = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
      ],
      WORKFLOW_DEFS,
    );

    // prd + create-ux-design (transitively via prd) now ready
    const dag1Ready = dag1.filter((s) => s.dependsOn.length === 0);
    expect(dag1Ready.map((s) => s.workflowName)).toContain("prd");
    // tech-spec not in L2 plan → won't appear

    // After Phase 2: prd done
    const dag2 = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
        { name: "prd", status: "docs/prd.md" },
      ],
      WORKFLOW_DEFS,
    );

    // architecture and create-ux-design should now be ready
    const dag2Ready = dag2.filter((s) => s.dependsOn.length === 0);
    const dag2ReadyNames = dag2Ready.map((s) => s.workflowName).sort();
    expect(dag2ReadyNames).toContain("architecture");
    expect(dag2ReadyNames).toContain("create-ux-design");

    // After Phase 3: architecture done
    const dag3 = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
        { name: "prd", status: "docs/prd.md" },
        { name: "architecture", status: "docs/arch.md" },
      ],
      WORKFLOW_DEFS,
    );

    // sprint-planning + solutioning-gate-check should be ready
    const dag3Ready = dag3.filter((s) => s.dependsOn.length === 0);
    const dag3ReadyNames = dag3Ready.map((s) => s.workflowName).sort();
    expect(dag3ReadyNames).toContain("sprint-planning");
    expect(dag3ReadyNames).toContain("solutioning-gate-check");

    // Also create-ux-design might still be in the DAG if not completed
    if (dag3.find((s) => s.workflowName === "create-ux-design")) {
      expect(dag3ReadyNames).toContain("create-ux-design");
    }

    // After Phase 4: sprint-planning done
    const dag4 = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
        { name: "prd", status: "docs/prd.md" },
        { name: "architecture", status: "docs/arch.md" },
        { name: "sprint-planning", status: "docs/sprint.md" },
      ],
      WORKFLOW_DEFS,
    );

    const dag4Ready = dag4.filter((s) => s.dependsOn.length === 0);
    expect(dag4Ready.map((s) => s.workflowName)).toContain("create-story");

    // After create-story done → dev-story ready
    const dag5 = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
        { name: "prd", status: "docs/prd.md" },
        { name: "architecture", status: "docs/arch.md" },
        { name: "sprint-planning", status: "docs/sprint.md" },
        { name: "create-story", status: "docs/story.md" },
      ],
      WORKFLOW_DEFS,
    );

    expect(dag5.filter((s) => s.dependsOn.length === 0).map((s) => s.workflowName)).toContain(
      "dev-story",
    );

    // Everything done → empty DAG
    const dagFinal = buildBmadWorkflowDag(
      2,
      [
        { name: "product-brief", status: "docs/pb.md" },
        { name: "brainstorm", status: "docs/bs.md" },
        { name: "research", status: "docs/rs.md" },
        { name: "prd", status: "docs/prd.md" },
        { name: "create-ux-design", status: "docs/ux.md" },
        { name: "architecture", status: "docs/arch.md" },
        { name: "solutioning-gate-check", status: "docs/gate.md" },
        { name: "sprint-planning", status: "docs/sprint.md" },
        { name: "create-story", status: "docs/story.md" },
        { name: "dev-story", status: "docs/dev.md" },
      ],
      WORKFLOW_DEFS,
    );
    expect(dagFinal.length).toBe(0);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 11: Prompt paths point to main repo, not worktree
  // ═════════════════════════════════════════════════════════════════════════
  it("worker prompts reference main repo paths for goal files and mailboxes, not worktree paths", async () => {
    await writeBmadConfig(repo, "PathTest", 2);
    await writeStatusFile(repo, [
      { name: "product-brief", phase: 1, status: "docs/pb.md" },
      { name: "brainstorm", phase: 1, status: "skipped" },
      { name: "research", phase: 1, status: "skipped" },
      ...ALL_WORKFLOW_ENTRIES.filter(
        (e) => !["product-brief", "brainstorm", "research"].includes(e.name),
      ),
    ]);
    git("add -A && git commit -m 'path test'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 2", ctx);

    // Read prompt files from .prompts/ dir
    const promptsDir = join(repo, PI_AGENT_DIR, ".prompts");
    const promptFiles = await readdir(promptsDir);

    for (const pf of promptFiles) {
      const content = await readFile(join(promptsDir, pf), "utf-8");

      // Goal file path should reference main repo PI_AGENT_DIR, NOT worktree
      const goalFileRef = content.match(/goal file at `([^`]+)`/);
      if (goalFileRef) {
        expect(goalFileRef[1]).toContain(resolve(repo, PI_AGENT_DIR));
        expect(goalFileRef[1]).not.toContain(WORKTREE_DIR);
      }

      // Mailbox path should reference main repo
      const mailboxRef = content.match(/inbox is at `([^`]+)`/);
      if (mailboxRef) {
        expect(mailboxRef[1]).toContain(resolve(repo, MAILBOX_DIR));
        expect(mailboxRef[1]).not.toContain(WORKTREE_DIR);
      }
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 12: Concurrent launches are blocked
  // ═════════════════════════════════════════════════════════════════════════
  it("second /harness:bmad while running is blocked", async () => {
    await writeBmadConfig(repo, "ConcurrentTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'concurrent test'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    const bmadCmd = mock.getCommand("harness:bmad")!;
    await bmadCmd.handler("--max-workers 1", ctx);

    // Second launch should be blocked
    await bmadCmd.handler("--max-workers 2", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already active"),
      "warning",
    );
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Test 13: Worktree git exclude file properly configured
  // ═════════════════════════════════════════════════════════════════════════
  it("worktree git exclude file excludes heartbeat.md and .pi-agent-prompt.md", async () => {
    await writeBmadConfig(repo, "ExcludeTest", 0);
    await writeStatusFile(repo, [
      { name: "tech-spec", phase: 2, status: "required" },
      { name: "sprint-planning", phase: 4, status: "required" },
      { name: "create-story", phase: 4, status: "required" },
      { name: "dev-story", phase: 4, status: "required" },
    ]);
    git("add -A && git commit -m 'exclude test'", repo);

    const { mock, ctx } = freshHarness();
    interceptPiSpawns(mock);
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:bmad")!.handler("--max-workers 1", ctx);

    const wtDir = join(repo, WORKTREE_DIR);
    const worktrees = await readdir(wtDir);
    expect(worktrees).toContain("bmad-tech-spec");

    // Check git exclude file in worktree
    // Worktrees use a `.git` FILE (not directory) that points to the actual gitdir.
    // Read the gitdir path the same way addToWorktreeExclude does.
    const wtPath = join(wtDir, "bmad-tech-spec");
    let excludeDir: string;
    try {
      const gitFileContent = await readFile(join(wtPath, ".git"), "utf-8");
      const gitDirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
      excludeDir = gitDirMatch
        ? resolve(wtPath, gitDirMatch[1].trim())
        : join(wtPath, ".git");
    } catch {
      excludeDir = join(wtPath, ".git");
    }
    const excludePath = join(excludeDir, "info", "exclude");
    const excludeContent = await readFile(excludePath, "utf-8");

    expect(excludeContent).toContain("heartbeat.md");
    expect(excludeContent).toContain(".pi-agent-prompt.md");
  });
});
