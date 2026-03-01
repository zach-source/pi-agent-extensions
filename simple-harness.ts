/**
 * Simple Harness — Plan-to-Execution Runner
 *
 * A focused extension that does one thing well: take an objective, generate tasks,
 * execute them in parallel workers, auto-merge results, and stop when done.
 *
 * No manager process (parent monitors directly via turn_end).
 * No mailbox/queue/registry complexity.
 *
 * Tools:
 *   run_status      - Show progress of all workers
 *   run_update_goal - Add/complete/remove goals on a worker
 *   run_plan        - Submit a structured task plan for execution
 *
 * Commands:
 *   /run [objective] [--max-workers N] [--stagger N] [--backend pi|claude]
 *   /run:status     - Show progress summary
 *   /run:stop       - Stop all workers
 *   /run:cleanup    - Remove all worktrees, branches, state
 *
 * Events:
 *   session_start      - Restore state, verify tmux sessions
 *   turn_end           - Monitor, auto-merge, dispatch pending, detect completion
 *   session_shutdown    - Persist state
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
  rename,
  stat,
  appendFile,
} from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "node:os";

// --- Shared imports from submodule-launcher ---
import {
  // Types
  type SubmoduleGoal,
  type SubmoduleQuestion,
  type SubmoduleConfig,
  type RepoSnapshot,
  type HarnessLogEntry,
  type HarnessRole,
  type ClaudeBackendConfig,
  type AccountRotationConfig,
  type CcswitchSequence,
  type CcswitchAccount,
  type UsageTrackingStore,
  type AccountUsageEntry,
  type AccountSessionUsage,
  type HarnessRuntimeConfig,
  type SessionBackend,
  type ModelRoute,
  // Constants
  HARNESS_ROLES,
  USAGE_TRACKING_FILE,
  HARNESS_CONFIG_FILE,
  MODEL_ROUTES_FILE,
  DEFAULT_MODEL_ROUTES,
  TMUX_SERVER,
  WORKER_STALL_THRESHOLD_MS,
  // Pure functions
  getRole,
  getToolPolicy,
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  buildRepoSnapshot,
  shellEscape,
  sanitizeTmuxName,
  goalFileName,
  buildWorkerCommand,
  buildMcpConfigForWorker,
  resolveModelForWorker,
  harnessLog,
  readCcswitchSequence,
  getAvailableAccounts,
  resolveAccountForWorker,
  buildUsageReport,
  validateRuntimeConfig,
  fuzzyMatchOne,
} from "./submodule-launcher.js";

// --- Constants ---

export const RUN_DIR = ".run";
export const RUN_STATE_FILE = ".run/.launch-state.json";
export const RUN_LOG_FILE = ".run/.run-log.jsonl";
export const STOP_SIGNAL_FILE = ".run/.stop-signal";
export const RUN_WORKTREE_DIR = ".run/worktrees";
export const RUN_USAGE_TRACKING_FILE = ".run/.usage-tracking.json";
export const MAX_WORKER_RECOVERIES = 3;

// Roles trimmed to 7 (no analyst, planner — those are BMAD-specific)
export const SIMPLE_HARNESS_ROLES: readonly string[] = [
  "developer",
  "architect",
  "tester",
  "reviewer",
  "researcher",
  "designer",
  "builder",
];

// --- Types ---

export interface WorkerSession {
  name: string;
  worktreePath: string;
  branch: string;
  spawned: boolean;
  spawnedAt: Date | null;
  tmuxSession: string | null;
  _lastCapture?: string;
  _stalledSince?: number | null;
  _recoveryCount?: number;
}

export interface PendingTask {
  name: string;
  role: string;
  goals: string[];
  context: string;
  dependsOn?: string[];
}

export interface RunState {
  active: boolean;
  objective?: string;
  sessions: Record<
    string,
    {
      worktreePath: string;
      branch: string;
      spawned: boolean;
      spawnedAt: string | null;
      tmuxSession: string | null;
    }
  >;
  pending: PendingTask[];
  maxWorkers: number;
  staggerMs: number;
  backend: SessionBackend;
  claudeConfig?: ClaudeBackendConfig;
  startedAt: string;
  mergedWorkers: string[];
  accountAssignments?: Record<string, { accountNumber: number; email: string }>;
}

// --- Pure functions for validation ---

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validate that all task names are valid kebab-case and unique. */
export function validateTaskNames(tasks: Array<{ name: string }>): {
  valid: boolean;
  error?: string;
} {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!KEBAB_CASE_RE.test(task.name)) {
      return {
        valid: false,
        error: `Invalid task name "${task.name}" — must be lowercase kebab-case (e.g., "fix-lint", "add-tests")`,
      };
    }
    if (seen.has(task.name)) {
      return { valid: false, error: `Duplicate task name "${task.name}"` };
    }
    seen.add(task.name);
  }
  return { valid: true };
}

/** Validate the dependency graph: all refs exist, no cycles. */
export function validateDependencyGraph(
  tasks: Array<{ name: string; dependsOn?: string[] }>,
): { valid: boolean; error?: string } {
  const allNames = new Set(tasks.map((t) => t.name));

  // Check all dependency references exist
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!allNames.has(dep)) {
        return {
          valid: false,
          error: `Task "${task.name}" depends on unknown task "${dep}"`,
        };
      }
      if (dep === task.name) {
        return {
          valid: false,
          error: `Task "${task.name}" depends on itself`,
        };
      }
    }
  }

  // Cycle detection via Kahn's algorithm (topological sort)
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.name, (task.dependsOn ?? []).length);
    for (const dep of task.dependsOn ?? []) {
      const edges = adjList.get(dep) ?? [];
      edges.push(task.name);
      adjList.set(dep, edges);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adjList.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited < tasks.length) {
    const cycleNodes = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([name]) => name);
    return {
      valid: false,
      error: `Dependency cycle detected: ${cycleNodes.join(" → ")}`,
    };
  }

  return { valid: true };
}

/** Separate tasks into ready (no unmet deps, within slot limit) and pending. */
export function partitionTasks(
  tasks: PendingTask[],
  maxWorkers: number,
  mergedWorkers: Set<string>,
): { ready: PendingTask[]; pending: PendingTask[] } {
  const ready: PendingTask[] = [];
  const pending: PendingTask[] = [];

  for (const task of tasks) {
    const unmetDeps = (task.dependsOn ?? []).filter(
      (d) => !mergedWorkers.has(d),
    );
    if (unmetDeps.length === 0 && ready.length < maxWorkers) {
      ready.push(task);
    } else {
      pending.push(task);
    }
  }

  return { ready, pending };
}

/** Build the worker prompt for a task. */
export function buildWorkerPrompt(
  task: PendingTask,
  goalFilePath: string,
  branch: string,
): string {
  const role = getRole(task.role);
  const policy = getToolPolicy(task.role);
  const lines: string[] = [
    `You are ${role.persona}, working on "${task.name}".`,
    "",
    "## Goals",
  ];

  for (const goal of task.goals) {
    lines.push(`- [ ] ${goal}`);
  }

  if (task.context) {
    lines.push("", "## Context", task.context);
  }

  lines.push("", "## Instructions");
  for (const instr of role.instructions) {
    lines.push(`- ${instr}`);
  }

  if (policy) {
    lines.push(`- **Access Level**: ${policy.instructions}`);
  }

  lines.push(
    `- You are working in a git worktree on branch \`${branch}\``,
    "- Your focus area is the repository root",
    `- When you complete a goal, edit your goal file at \`${goalFilePath}\` to mark \`- [ ]\` as \`- [x]\``,
    "- Commit your work frequently",
    "- Do not switch branches",
    "- NEVER modify heartbeat.md or .pi-agent-prompt.md",
    "",
    "## Questions",
    "If you need clarification, append to the `## Questions` section in your goal file:",
    "`- ? Your question here`",
    "Then periodically re-read the file for answers (lines starting with `- !`).",
    "",
  );

  return lines.join("\n");
}

/** Serialize RunState to JSON string. */
export function serializeRunState(state: RunState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/** Deserialize RunState from JSON string. Returns null on failure. */
export function deserializeRunState(content: string): RunState | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.active !== "boolean") return null;
    if (typeof parsed.sessions !== "object" || parsed.sessions === null)
      return null;
    if (!Array.isArray(parsed.pending)) return null;
    if (typeof parsed.maxWorkers !== "number") return null;
    if (typeof parsed.staggerMs !== "number") return null;
    if (parsed.backend !== "pi" && parsed.backend !== "claude") return null;
    if (typeof parsed.startedAt !== "string") return null;
    if (!Array.isArray(parsed.mergedWorkers)) return null;
    return parsed as RunState;
  } catch {
    return null;
  }
}

/** Build the planning prompt returned by /run. */
export function buildPlanningPrompt(
  snapshot: RepoSnapshot,
  objective: string,
  roles: readonly string[],
): string {
  const roleList = roles
    .map((r) => {
      const role = getRole(r);
      return `- **${role.name}**: ${role.persona}`;
    })
    .join("\n");

  return [
    "## Repository Snapshot",
    "",
    "### File Tree",
    "```",
    snapshot.fileTree,
    "```",
    "",
    `### Languages: ${snapshot.languages.join(", ") || "unknown"}`,
    `### Frameworks: ${snapshot.frameworks.join(", ") || "none detected"}`,
    `### Test Framework: ${snapshot.testFramework ?? "none detected"}`,
    `### Branch: ${snapshot.branchName}`,
    "",
    "### Recent Commits",
    snapshot.recentCommits.map((c) => `- ${c}`).join("\n"),
    "",
    snapshot.existingTasks.length > 0
      ? `### Existing Tasks: ${snapshot.existingTasks.join(", ")}`
      : "",
    snapshot.todoCount > 0
      ? `### TODO/FIXME/HACK count: ${snapshot.todoCount}`
      : "",
    "",
    "---",
    "",
    "## Objective",
    "",
    objective,
    "",
    "---",
    "",
    "## Your Task",
    "",
    "Analyze the repository snapshot above and break the objective into concrete tasks.",
    "Call the `run_plan` tool with a structured task breakdown.",
    "",
    "### Available Roles",
    roleList,
    "",
    "### Task Schema",
    "Each task must have:",
    "- `name`: kebab-case identifier (e.g., `fix-lint`, `add-auth-tests`)",
    "- `role`: one of the available roles above",
    "- `goals`: array of concrete, actionable goal strings",
    "- `context`: relevant context for the worker (file paths, patterns, constraints)",
    "- `dependsOn` (optional): array of task names that must complete first",
    "",
    "### Guidelines",
    "- Prefer 2-5 tasks for most objectives",
    "- Each task should be independently completable within its worktree",
    "- Use dependencies sparingly — parallel execution is faster",
    "- Goals should be specific enough to verify completion",
    "- Choose roles that match the work (tester for tests, architect for refactoring, etc.)",
    "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

// --- Atomic file write (not exported from submodule-launcher) ---

let _atomicCounter = 0;
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tmp = filePath + `.tmp.${process.pid}.${++_atomicCounter}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

// --- Tool Schemas ---

const RunStatusParams = Type.Object({});
type RunStatusInput = Static<typeof RunStatusParams>;

const RunUpdateGoalParams = Type.Object({
  worker: Type.String({
    description: "Worker name (matches filename or # heading)",
  }),
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("complete"), Type.Literal("remove")],
    { description: "Action: 'add', 'complete', or 'remove'" },
  ),
  goal: Type.String({ description: "Goal text to add, complete, or remove" }),
});
type RunUpdateGoalInput = Static<typeof RunUpdateGoalParams>;

const RunPlanParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      name: Type.String({ description: "Kebab-case task identifier" }),
      role: Type.String({
        description:
          "Worker role: developer, architect, tester, reviewer, researcher, designer, builder",
      }),
      goals: Type.Array(Type.String(), {
        description: "List of concrete goals",
      }),
      context: Type.String({ description: "Context for the worker agent" }),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description: "Task names that must complete first",
        }),
      ),
    }),
    { description: "Array of task definitions" },
  ),
});
type RunPlanInput = Static<typeof RunPlanParams>;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let loopActive = false;
  let sessions: Map<string, WorkerSession> = new Map();
  let pendingTasks: PendingTask[] = [];
  const mergedWorkers = new Set<string>();
  let runObjective: string | undefined;
  let runStartedAt: Date | null = null;
  let effectiveMaxWorkers = 3;
  let effectiveStaggerMs = 5000;
  let effectiveBackend: SessionBackend = "pi";
  let effectiveClaudeConfig: ClaudeBackendConfig | undefined;
  let lastCtx: {
    ui: { notify: Function; setStatus: Function };
  } | null = null;

  // Account rotation state
  let accountSpawnIndex = 0;
  let accountAssignments: Map<
    string,
    { accountNumber: number; email: string }
  > = new Map();

  // Config reload mtime tracking
  let cachedConfigMtime = 0;
  let cachedModelRoutesMtime = 0;

  // Trace logging bound to cwd
  const hlog = (
    event: string,
    data?: Record<string, unknown>,
    level?: HarnessLogEntry["level"],
  ) => harnessLog(cwd, event, data, level);

  // --- Tmux Helpers ---

  async function tmuxNewSession(
    name: string,
    cmd: string,
    sessionCwd: string,
  ): Promise<void> {
    await pi.exec(
      "tmux",
      ["-L", TMUX_SERVER, "new-session", "-d", "-s", name, "-c", sessionCwd],
      {},
    );
    await pi.exec(
      "tmux",
      ["-L", TMUX_SERVER, "send-keys", "-t", name, cmd, "Enter"],
      {},
    );
  }

  async function tmuxHasSession(name: string): Promise<boolean> {
    try {
      const result = await pi.exec(
        "tmux",
        ["-L", TMUX_SERVER, "has-session", "-t", name],
        {},
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function tmuxKillSession(name: string): Promise<void> {
    try {
      await pi.exec(
        "tmux",
        ["-L", TMUX_SERVER, "kill-session", "-t", name],
        {},
      );
    } catch {
      /* session may already be dead */
    }
  }

  async function tmuxCapture(name: string, lines = 50): Promise<string> {
    try {
      const result = await pi.exec(
        "tmux",
        [
          "-L",
          TMUX_SERVER,
          "capture-pane",
          "-t",
          name,
          "-p",
          "-",
          String(lines),
        ],
        {},
      );
      return result.stdout;
    } catch {
      return "";
    }
  }

  async function tmuxListSessions(): Promise<string[]> {
    try {
      const result = await pi.exec(
        "tmux",
        ["-L", TMUX_SERVER, "list-sessions", "-F", "#{session_name}"],
        {},
      );
      return result.stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  // --- File Helpers ---

  async function getFileMtime(path: string): Promise<number> {
    try {
      const st = await stat(path);
      return st.mtimeMs;
    } catch {
      return 0;
    }
  }

  async function addToWorktreeExclude(
    worktreePath: string,
    pattern: string,
  ): Promise<void> {
    try {
      const excludeFile = join(worktreePath, ".git", "info", "exclude");
      try {
        const existing = await readFile(excludeFile, "utf-8");
        if (existing.includes(pattern)) return;
      } catch {
        /* file doesn't exist yet */
      }
      await mkdir(join(worktreePath, ".git", "info"), { recursive: true });
      await appendFile(excludeFile, `${pattern}\n`);
    } catch {
      /* best effort */
    }
  }

  // --- Worktree & Session Management ---

  async function createWorktree(task: PendingTask): Promise<WorkerSession> {
    const branch = `pi-agent/${task.name}`;
    const worktreePath = resolve(cwd, RUN_WORKTREE_DIR, task.name);

    // Ensure parent directory exists
    await mkdir(resolve(cwd, RUN_WORKTREE_DIR), { recursive: true });

    // Create the worktree
    await pi.exec("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd,
    });

    // Write heartbeat.md for compatibility
    await writeFile(
      join(worktreePath, "heartbeat.md"),
      `# ${task.name}\nCreated: ${new Date().toISOString()}\n`,
      "utf-8",
    );

    // Exclude generated files
    for (const pattern of [
      ".pi-agent-prompt.md",
      "heartbeat.md",
      ".claude-mcp-config.json",
    ]) {
      await addToWorktreeExclude(worktreePath, pattern);
    }

    const session: WorkerSession = {
      name: task.name,
      worktreePath,
      branch,
      spawned: false,
      spawnedAt: null,
      tmuxSession: null,
      _recoveryCount: 0,
    };

    sessions.set(task.name, session);
    return session;
  }

  async function spawnSession(
    session: WorkerSession,
    task: PendingTask,
  ): Promise<void> {
    // Build goal file
    const goalFile = goalFileName(task.name);
    const goalFilePath = resolve(cwd, RUN_DIR, goalFile);

    // Write the goal file in .run/
    await mkdir(resolve(cwd, RUN_DIR), { recursive: true });
    const config: SubmoduleConfig = {
      name: task.name,
      path: ".",
      role: task.role,
      goals: task.goals.map((text) => ({ text, completed: false })),
      questions: [],
      context: task.context,
      rawContent: "",
      dependsOn: task.dependsOn,
    };
    await atomicWriteFile(goalFilePath, serializeGoalFile(config));

    // Build worker prompt
    const prompt = buildWorkerPrompt(task, goalFilePath, session.branch);
    const promptPath = join(session.worktreePath, ".pi-agent-prompt.md");
    await writeFile(promptPath, prompt, "utf-8");

    // Resolve model via model routes
    let modelRoutes: ModelRoute[] = DEFAULT_MODEL_ROUTES;
    try {
      const routesContent = await readFile(
        join(cwd, MODEL_ROUTES_FILE),
        "utf-8",
      );
      modelRoutes = JSON.parse(routesContent) as ModelRoute[];
    } catch {
      /* use defaults */
    }
    const claudeModel = resolveModelForWorker(
      modelRoutes,
      task.role,
      task.name,
    );

    // Build MCP config for Claude backend
    let mcpConfigFile: string | null = null;
    if (effectiveBackend === "claude") {
      mcpConfigFile = await buildMcpConfigForWorker(
        session.worktreePath,
        effectiveClaudeConfig?.mcpServers,
        effectiveClaudeConfig?.mcpConfigPath,
      );
      if (mcpConfigFile) {
        await addToWorktreeExclude(
          session.worktreePath,
          ".claude-mcp-config.json",
        );
      }
    }

    // Account rotation
    await switchAccountBeforeSpawn(session.name);

    // Build command
    const piModelFlag = claudeModel ? ` --model ${claudeModel}` : "";
    const cmd = buildWorkerCommand(
      effectiveBackend,
      piModelFlag,
      effectiveClaudeConfig,
      claudeModel ?? undefined,
      mcpConfigFile,
    );

    // Spawn tmux session
    const tmuxName = sanitizeTmuxName(`run-${session.name}`);
    await tmuxNewSession(tmuxName, cmd, session.worktreePath);

    session.spawned = true;
    session.spawnedAt = new Date();
    session.tmuxSession = tmuxName;

    await hlog("worker_spawned", {
      worker: session.name,
      tmux: tmuxName,
      branch: session.branch,
      backend: effectiveBackend,
    });
  }

  async function mergeWorktree(
    session: WorkerSession,
  ): Promise<{ ok: boolean; message: string }> {
    // Double-merge guard
    if (mergedWorkers.has(session.name)) {
      return { ok: false, message: `${session.name} already merged` };
    }

    // Check for unanswered questions
    const goalFile = goalFileName(session.name);
    const goalPath = join(cwd, RUN_DIR, goalFile);
    try {
      const content = await readFile(goalPath, "utf-8");
      const config = parseGoalFile(content, goalFile);
      const unanswered = config.questions.filter((q) => !q.answered);
      if (unanswered.length > 0) {
        return {
          ok: false,
          message: `${session.name} has ${unanswered.length} unanswered question(s)`,
        };
      }
    } catch {
      /* goal file may not exist */
    }

    // Attempt merge
    try {
      const result = await pi.exec(
        "git",
        ["merge", session.branch, "--no-edit"],
        { cwd },
      );
      if (result.exitCode !== 0) {
        // Abort failed merge
        await pi.exec("git", ["merge", "--abort"], { cwd }).catch(() => {});
        return {
          ok: false,
          message: `Merge failed for ${session.name}: ${result.stderr}`,
        };
      }
    } catch (err) {
      await pi.exec("git", ["merge", "--abort"], { cwd }).catch(() => {});
      return {
        ok: false,
        message: `Merge error for ${session.name}: ${err}`,
      };
    }

    // Remove worktree + branch
    await removeWorktree(session);

    // Track as merged
    mergedWorkers.add(session.name);
    sessions.delete(session.name);

    await hlog("worker_merged", { worker: session.name });

    return { ok: true, message: `Merged ${session.name}` };
  }

  async function removeWorktree(
    session: WorkerSession,
    force = false,
  ): Promise<void> {
    // Kill tmux session if alive
    if (session.tmuxSession) {
      await tmuxKillSession(session.tmuxSession);
    }

    // Remove worktree
    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(session.worktreePath);
      await pi.exec("git", args, { cwd });
    } catch {
      // Force remove if normal fails
      if (!force) {
        try {
          await pi.exec(
            "git",
            ["worktree", "remove", "--force", session.worktreePath],
            { cwd },
          );
        } catch {
          /* best effort */
        }
      }
    }

    // Delete branch
    try {
      await pi.exec("git", ["branch", "-D", session.branch], { cwd });
    } catch {
      /* branch may already be deleted */
    }
  }

  // --- State Persistence ---

  async function persistState(): Promise<void> {
    const sessionsObj: RunState["sessions"] = {};
    for (const [name, s] of sessions) {
      sessionsObj[name] = {
        worktreePath: s.worktreePath,
        branch: s.branch,
        spawned: s.spawned,
        spawnedAt: s.spawnedAt?.toISOString() ?? null,
        tmuxSession: s.tmuxSession,
      };
    }

    const assignmentsObj: Record<
      string,
      { accountNumber: number; email: string }
    > = {};
    for (const [name, a] of accountAssignments) {
      assignmentsObj[name] = a;
    }

    const state: RunState = {
      active: loopActive,
      objective: runObjective,
      sessions: sessionsObj,
      pending: pendingTasks,
      maxWorkers: effectiveMaxWorkers,
      staggerMs: effectiveStaggerMs,
      backend: effectiveBackend,
      claudeConfig: effectiveClaudeConfig,
      startedAt: runStartedAt?.toISOString() ?? new Date().toISOString(),
      mergedWorkers: Array.from(mergedWorkers),
      accountAssignments:
        Object.keys(assignmentsObj).length > 0 ? assignmentsObj : undefined,
    };

    await mkdir(resolve(cwd, RUN_DIR), { recursive: true });
    await atomicWriteFile(
      resolve(cwd, RUN_STATE_FILE),
      serializeRunState(state),
    );
  }

  async function restoreState(): Promise<boolean> {
    try {
      const content = await readFile(resolve(cwd, RUN_STATE_FILE), "utf-8");
      const state = deserializeRunState(content);
      if (!state) return false;

      loopActive = state.active;
      runObjective = state.objective;
      pendingTasks = state.pending;
      effectiveMaxWorkers = state.maxWorkers;
      effectiveStaggerMs = state.staggerMs;
      effectiveBackend = state.backend;
      effectiveClaudeConfig = state.claudeConfig;
      runStartedAt = new Date(state.startedAt);
      mergedWorkers.clear();
      for (const w of state.mergedWorkers) {
        mergedWorkers.add(w);
      }

      // Reconstruct sessions
      sessions.clear();
      for (const [name, s] of Object.entries(state.sessions)) {
        sessions.set(name, {
          name,
          worktreePath: s.worktreePath,
          branch: s.branch,
          spawned: s.spawned,
          spawnedAt: s.spawnedAt ? new Date(s.spawnedAt) : null,
          tmuxSession: s.tmuxSession,
          _recoveryCount: 0,
        });
      }

      // Restore account assignments
      accountAssignments.clear();
      if (state.accountAssignments) {
        for (const [name, a] of Object.entries(state.accountAssignments)) {
          accountAssignments.set(name, a);
        }
        accountSpawnIndex = Object.keys(state.accountAssignments).length;
      }

      // Verify tmux sessions still alive
      const liveSessions = await tmuxListSessions();
      const liveSet = new Set(liveSessions);
      for (const [name, session] of sessions) {
        if (session.tmuxSession && !liveSet.has(session.tmuxSession)) {
          session.spawned = false;
          session.tmuxSession = null;
          await hlog("dead_session_detected", { worker: name }, "warn");
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  // --- Account Rotation ---

  async function switchAccount(accountNumber: number): Promise<boolean> {
    try {
      const ccswitchPath =
        effectiveClaudeConfig?.accountRotation?.ccswitchPath ?? "ccswitch";
      const result = await pi.exec(
        ccswitchPath,
        ["--switch-to", String(accountNumber)],
        {},
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function switchAccountBeforeSpawn(workerName: string): Promise<void> {
    const rotation = effectiveClaudeConfig?.accountRotation;
    if (!rotation?.enabled) return;

    const sequence = await readCcswitchSequence(rotation.sequenceFilePath);
    if (!sequence) {
      await hlog(
        "account_rotation_skip",
        { reason: "no sequence file" },
        "warn",
      );
      return;
    }

    const accounts = getAvailableAccounts(sequence);
    if (accounts.length === 0) {
      await hlog("account_rotation_skip", { reason: "no accounts" }, "warn");
      return;
    }

    // Read usage tracking
    let usage: UsageTrackingStore | null = null;
    try {
      const content = await readFile(
        resolve(cwd, RUN_USAGE_TRACKING_FILE),
        "utf-8",
      );
      usage = JSON.parse(content) as UsageTrackingStore;
    } catch {
      /* no tracking data yet */
    }

    const account = resolveAccountForWorker(
      accounts,
      accountSpawnIndex,
      usage,
      rotation.usageThresholdUsd,
    );

    if (account) {
      const switched = await switchAccount(account.number);
      if (switched) {
        accountAssignments.set(workerName, {
          accountNumber: account.number,
          email: account.email,
        });
        accountSpawnIndex++;
        await hlog("account_switched", {
          worker: workerName,
          account: account.number,
          email: account.email,
        });
      }
    }
  }

  async function readUsageTracking(): Promise<UsageTrackingStore> {
    try {
      const content = await readFile(
        resolve(cwd, RUN_USAGE_TRACKING_FILE),
        "utf-8",
      );
      return JSON.parse(content) as UsageTrackingStore;
    } catch {
      return { version: 1, accounts: [], updatedAt: new Date().toISOString() };
    }
  }

  async function writeUsageTracking(store: UsageTrackingStore): Promise<void> {
    await mkdir(resolve(cwd, RUN_DIR), { recursive: true });
    await atomicWriteFile(
      resolve(cwd, RUN_USAGE_TRACKING_FILE),
      JSON.stringify(store, null, 2) + "\n",
    );
  }

  // --- Config Loading ---

  async function loadConfig(): Promise<void> {
    // Read .harness-config.json (shared format)
    const configPath = resolve(cwd, HARNESS_CONFIG_FILE);
    const mtime = await getFileMtime(configPath);
    if (mtime > 0 && mtime !== cachedConfigMtime) {
      cachedConfigMtime = mtime;
      try {
        const content = await readFile(configPath, "utf-8");
        const raw = JSON.parse(content);
        const validated = validateRuntimeConfig(raw);
        if (validated) {
          effectiveMaxWorkers = validated.maxWorkers ?? 3;
          effectiveStaggerMs = validated.staggerMs ?? 5000;
          effectiveBackend = validated.backend ?? "pi";
          effectiveClaudeConfig = validated.claudeConfig;
        }
      } catch {
        /* use defaults */
      }
    }
  }

  // --- Read goal files from .run/ ---

  async function readAllGoalFiles(): Promise<SubmoduleConfig[]> {
    const runDir = resolve(cwd, RUN_DIR);
    const configs: SubmoduleConfig[] = [];
    try {
      const files = await readdir(runDir);
      for (const file of files) {
        if (file.endsWith(".md") && !file.startsWith(".")) {
          try {
            const content = await readFile(join(runDir, file), "utf-8");
            configs.push(parseGoalFile(content, file));
          } catch {
            /* skip unreadable files */
          }
        }
      }
    } catch {
      /* directory doesn't exist */
    }
    return configs;
  }

  // --- Tools ---

  pi.registerTool({
    name: "run_status",
    label: "Run Status",
    description: "Show progress of all workers in the current run",
    parameters: RunStatusParams,
    renderResult(result, { expanded }, theme) {
      const text =
        typeof result === "string"
          ? result
          : (result?.content?.[0]?.text ?? JSON.stringify(result));
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, _params: RunStatusInput) {
      const configs = await readAllGoalFiles();
      if (configs.length === 0) {
        return {
          content: [
            { type: "text", text: "No active run. Use /run to start one." },
          ],
        };
      }

      const progressLines: string[] = [];
      progressLines.push("## Run Status\n");
      if (runObjective) {
        progressLines.push(`**Objective**: ${runObjective}\n`);
      }

      // Active workers
      for (const config of configs) {
        const total = config.goals.length;
        const done = config.goals.filter((g) => g.completed).length;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const session = sessions.get(config.name);
        const isActive = session?.spawned ?? false;
        const statusIcon =
          done === total ? "DONE" : isActive ? "ACTIVE" : "PENDING";
        const roleTag =
          config.role !== "developer" ? ` [${getRole(config.role).label}]` : "";

        progressLines.push(
          `### ${config.name}${roleTag} — ${statusIcon} (${done}/${total}, ${pct}%)`,
        );
        for (const goal of config.goals) {
          progressLines.push(`- [${goal.completed ? "x" : " "}] ${goal.text}`);
        }

        const unanswered = config.questions.filter((q) => !q.answered);
        if (unanswered.length > 0) {
          for (const q of unanswered) {
            progressLines.push(`- ? ${q.text}`);
          }
        }
        progressLines.push("");
      }

      // Merged workers
      if (mergedWorkers.size > 0) {
        progressLines.push(
          `**Merged**: ${Array.from(mergedWorkers).join(", ")}`,
        );
      }

      // Pending tasks
      if (pendingTasks.length > 0) {
        progressLines.push(
          `**Pending**: ${pendingTasks.map((t) => t.name).join(", ")}`,
        );
      }

      // Account rotation report
      const rotation = effectiveClaudeConfig?.accountRotation;
      if (rotation?.enabled) {
        const usage = await readUsageTracking();
        progressLines.push("", buildUsageReport(usage));
      }

      return {
        content: [{ type: "text", text: progressLines.join("\n") }],
      };
    },
  });

  pi.registerTool({
    name: "run_update_goal",
    label: "Run Update Goal",
    description: "Add, complete, or remove a goal on a worker",
    parameters: RunUpdateGoalParams,
    async execute(_toolCallId, params: RunUpdateGoalInput) {
      const runDir = resolve(cwd, RUN_DIR);

      // Find matching goal file
      let files: string[];
      try {
        files = await readdir(runDir);
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "No .run/ directory found. Is a run active?",
            },
          ],
        };
      }

      const mdFiles = files.filter(
        (f) => f.endsWith(".md") && !f.startsWith("."),
      );
      const configs: Array<{ config: SubmoduleConfig; file: string }> = [];
      for (const file of mdFiles) {
        try {
          const content = await readFile(join(runDir, file), "utf-8");
          configs.push({ config: parseGoalFile(content, file), file });
        } catch {
          continue;
        }
      }

      const match = fuzzyMatchOne(configs, (c) => c.config.name, params.worker);

      if (!match) {
        return {
          content: [
            {
              type: "text",
              text: `No worker matching "${params.worker}" found. Available: ${configs.map((c) => c.config.name).join(", ")}`,
            },
          ],
        };
      }

      if ("ambiguous" in match) {
        return {
          content: [
            {
              type: "text",
              text: `Ambiguous match for "${params.worker}": ${match.ambiguous.map((c) => c.config.name).join(", ")}`,
            },
          ],
        };
      }

      const { config, file } = match.match;

      // Apply action
      if (params.action === "add") {
        config.goals.push({ text: params.goal, completed: false });
      } else if (params.action === "complete") {
        const goalMatch = fuzzyMatchOne(
          config.goals.filter((g) => !g.completed),
          (g) => g.text,
          params.goal,
        );
        if (!goalMatch) {
          return {
            content: [
              {
                type: "text",
                text: `No uncompleted goal matching "${params.goal}" in ${config.name}`,
              },
            ],
          };
        }
        if ("ambiguous" in goalMatch) {
          return {
            content: [
              {
                type: "text",
                text: `Ambiguous goal match: ${goalMatch.ambiguous.map((g) => g.text).join(", ")}`,
              },
            ],
          };
        }
        goalMatch.match.completed = true;
      } else if (params.action === "remove") {
        const goalMatch = fuzzyMatchOne(
          config.goals,
          (g) => g.text,
          params.goal,
        );
        if (!goalMatch) {
          return {
            content: [
              {
                type: "text",
                text: `No goal matching "${params.goal}" in ${config.name}`,
              },
            ],
          };
        }
        if ("ambiguous" in goalMatch) {
          return {
            content: [
              {
                type: "text",
                text: `Ambiguous goal match: ${goalMatch.ambiguous.map((g) => g.text).join(", ")}`,
              },
            ],
          };
        }
        config.goals = config.goals.filter((g) => g !== goalMatch.match);
      }

      // Write updated goal file
      await atomicWriteFile(join(runDir, file), serializeGoalFile(config));

      const done = config.goals.filter((g) => g.completed).length;
      const total = config.goals.length;
      return {
        content: [
          {
            type: "text",
            text: `${params.action === "add" ? "Added" : params.action === "complete" ? "Completed" : "Removed"} goal on ${config.name}. Progress: ${done}/${total}`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "run_plan",
    label: "Run Plan",
    description:
      "Submit a structured task plan for parallel execution. Called after /run provides a repo snapshot.",
    parameters: RunPlanParams,
    async execute(_toolCallId, params: RunPlanInput) {
      // Validate task names
      const nameCheck = validateTaskNames(params.tasks);
      if (!nameCheck.valid) {
        return {
          content: [{ type: "text", text: `Plan error: ${nameCheck.error}` }],
        };
      }

      // Validate roles
      for (const task of params.tasks) {
        if (!SIMPLE_HARNESS_ROLES.includes(task.role)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid role "${task.role}" for task "${task.name}". Valid roles: ${SIMPLE_HARNESS_ROLES.join(", ")}`,
              },
            ],
          };
        }
      }

      // Validate dependency graph
      const depCheck = validateDependencyGraph(params.tasks);
      if (!depCheck.valid) {
        return {
          content: [{ type: "text", text: `Plan error: ${depCheck.error}` }],
        };
      }

      // Create .run/ directory
      await mkdir(resolve(cwd, RUN_DIR), { recursive: true });

      // Build PendingTask list
      const allTasks: PendingTask[] = params.tasks.map((t) => ({
        name: t.name,
        role: t.role,
        goals: t.goals,
        context: t.context,
        dependsOn: t.dependsOn,
      }));

      // Partition into ready and pending
      const { ready, pending } = partitionTasks(
        allTasks,
        effectiveMaxWorkers,
        mergedWorkers,
      );

      pendingTasks = pending;
      runStartedAt = new Date();

      // Spawn ready workers
      const launchReport: string[] = [];
      launchReport.push(`## Run Plan Accepted\n`);
      launchReport.push(`**Tasks**: ${allTasks.length}`);
      launchReport.push(`**Ready to launch**: ${ready.length}`);
      launchReport.push(`**Queued**: ${pending.length}`);
      launchReport.push("");

      for (let i = 0; i < ready.length; i++) {
        const task = ready[i];
        try {
          const session = await createWorktree(task);

          // Stagger delay between spawns
          if (i > 0 && effectiveStaggerMs > 0) {
            await new Promise((r) => setTimeout(r, effectiveStaggerMs));
          }

          await spawnSession(session, task);
          launchReport.push(
            `- **${task.name}** [${getRole(task.role).label}] — spawned (${task.goals.length} goals)`,
          );
        } catch (err) {
          launchReport.push(`- **${task.name}** — FAILED to spawn: ${err}`);
          await hlog(
            "spawn_error",
            { worker: task.name, error: String(err) },
            "error",
          );
        }
      }

      if (pending.length > 0) {
        launchReport.push("");
        launchReport.push("### Queued Tasks");
        for (const task of pending) {
          const deps = task.dependsOn?.length
            ? ` (after: ${task.dependsOn.join(", ")})`
            : " (waiting for slot)";
          launchReport.push(
            `- **${task.name}** [${getRole(task.role).label}]${deps}`,
          );
        }
      }

      // Activate monitoring loop
      loopActive = true;
      await persistState();

      await hlog("plan_accepted", {
        tasks: allTasks.length,
        ready: ready.length,
        pending: pending.length,
      });

      return {
        content: [{ type: "text", text: launchReport.join("\n") }],
      };
    },
  });

  // --- Commands ---

  pi.registerCommand("run", {
    description:
      "Start a parallel run. Usage: /run [objective] [--max-workers N] [--stagger N] [--backend pi|claude]",
    handler: async (args: string, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      // Check for existing active run
      if (loopActive) {
        pi.sendMessage(
          {
            customType: "run-error",
            content:
              "A run is already active. Use /run:stop first, or /run:status to check progress.",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      // Parse flags
      let objective = args;
      let maxWorkersOverride: number | undefined;
      let staggerOverride: number | undefined;
      let backendOverride: SessionBackend | undefined;

      const flagPatterns = [
        {
          re: /--max-workers\s+(\d+)/i,
          apply: (m: RegExpMatchArray) => {
            maxWorkersOverride = parseInt(m[1], 10);
          },
        },
        {
          re: /--stagger\s+(\d+)/i,
          apply: (m: RegExpMatchArray) => {
            staggerOverride = parseInt(m[1], 10);
          },
        },
        {
          re: /--backend\s+(pi|claude)/i,
          apply: (m: RegExpMatchArray) => {
            backendOverride = m[1] as SessionBackend;
          },
        },
      ];

      for (const { re, apply } of flagPatterns) {
        const match = objective.match(re);
        if (match) {
          apply(match);
          objective = objective.replace(re, "").trim();
        }
      }

      if (!objective) {
        pi.sendMessage(
          {
            customType: "run-error",
            content:
              "Usage: /run <objective> [--max-workers N] [--stagger N] [--backend pi|claude]",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      // Load config
      await loadConfig();

      // Apply overrides
      if (maxWorkersOverride !== undefined)
        effectiveMaxWorkers = maxWorkersOverride;
      if (staggerOverride !== undefined) effectiveStaggerMs = staggerOverride;
      if (backendOverride !== undefined) effectiveBackend = backendOverride;

      runObjective = objective;

      // Gather repo snapshot
      const snapshot = await buildRepoSnapshot(cwd, pi);

      // Build planning prompt and return it as a user message
      const planPrompt = buildPlanningPrompt(
        snapshot,
        objective,
        SIMPLE_HARNESS_ROLES,
      );

      await hlog("run_started", {
        objective,
        maxWorkers: effectiveMaxWorkers,
        stagger: effectiveStaggerMs,
        backend: effectiveBackend,
      });

      // Send the planning prompt to trigger LLM analysis + run_plan call
      pi.sendUserMessage(planPrompt);
    },
  });

  pi.registerCommand("run:status", {
    description: "Show run progress summary",
    handler: async (_args: string, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      const configs = await readAllGoalFiles();
      if (configs.length === 0 && mergedWorkers.size === 0) {
        pi.sendMessage(
          {
            customType: "run-status",
            content: "No active run. Use /run to start one.",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const lines: string[] = [];
      lines.push("## Run Status\n");
      if (runObjective) lines.push(`**Objective**: ${runObjective}\n`);

      let totalGoals = 0;
      let completedGoals = 0;
      let activeCount = 0;
      let stalledCount = 0;
      let deadCount = 0;

      for (const config of configs) {
        const total = config.goals.length;
        const done = config.goals.filter((g) => g.completed).length;
        totalGoals += total;
        completedGoals += done;

        const session = sessions.get(config.name);
        let status = "PENDING";
        if (session?.spawned) {
          const alive = session.tmuxSession
            ? await tmuxHasSession(session.tmuxSession)
            : false;
          if (!alive) {
            status = "DEAD";
            deadCount++;
          } else if (session._stalledSince) {
            status = "STALLED";
            stalledCount++;
          } else {
            status = "ACTIVE";
            activeCount++;
          }
        }

        const roleTag =
          config.role !== "developer" ? ` [${getRole(config.role).label}]` : "";
        lines.push(
          `**${config.name}**${roleTag} — ${status} (${done}/${total})`,
        );
      }

      lines.push("");
      lines.push(
        `**Summary**: ${completedGoals}/${totalGoals} goals | ${activeCount}a/${stalledCount}s/${deadCount}d`,
      );
      if (mergedWorkers.size > 0) {
        lines.push(`**Merged**: ${Array.from(mergedWorkers).join(", ")}`);
      }
      if (pendingTasks.length > 0) {
        lines.push(
          `**Pending**: ${pendingTasks.map((t) => t.name).join(", ")}`,
        );
      }

      pi.sendMessage(
        { customType: "run-status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("run:stop", {
    description: "Stop all workers and the monitoring loop",
    handler: async (_args: string, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      // Write stop signal file
      await mkdir(resolve(cwd, RUN_DIR), { recursive: true });
      await writeFile(
        resolve(cwd, STOP_SIGNAL_FILE),
        new Date().toISOString(),
        "utf-8",
      );

      // Kill all worker tmux sessions
      const killed: string[] = [];
      for (const [name, session] of sessions) {
        if (session.tmuxSession) {
          await tmuxKillSession(session.tmuxSession);
          killed.push(name);
        }
      }

      loopActive = false;
      await persistState();

      await hlog("run_stopped", { killed });

      pi.sendMessage(
        {
          customType: "run-stopped",
          content: `Run stopped. Killed ${killed.length} worker(s): ${killed.join(", ") || "none"}. State preserved in ${RUN_STATE_FILE}.`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("run:cleanup", {
    description: "Remove all worktrees, branches, and state from .run/",
    handler: async (_args: string, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      // Kill all tmux sessions
      const tmuxSessions = await tmuxListSessions();
      for (const name of tmuxSessions) {
        if (name.startsWith("run-")) {
          await tmuxKillSession(name);
        }
      }

      // Remove all worktrees
      for (const [, session] of sessions) {
        await removeWorktree(session, true);
      }

      // Also remove any orphaned worktrees in .run/worktrees/
      try {
        const worktreeDir = resolve(cwd, RUN_WORKTREE_DIR);
        const entries = await readdir(worktreeDir);
        for (const entry of entries) {
          try {
            await pi.exec(
              "git",
              ["worktree", "remove", "--force", join(worktreeDir, entry)],
              { cwd },
            );
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* directory doesn't exist */
      }

      // Delete orphaned pi-agent/* branches
      try {
        const result = await pi.exec(
          "git",
          ["branch", "--list", "pi-agent/*"],
          { cwd },
        );
        const branches = result.stdout
          .trim()
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean);
        for (const branch of branches) {
          try {
            await pi.exec("git", ["branch", "-D", branch], { cwd });
          } catch {
            /* skip */
          }
        }
      } catch {
        /* no branches to delete */
      }

      // Remove .run/ directory
      try {
        await rm(resolve(cwd, RUN_DIR), { recursive: true, force: true });
      } catch {
        /* already gone */
      }

      // Reset closure state
      sessions.clear();
      pendingTasks = [];
      mergedWorkers.clear();
      loopActive = false;
      runObjective = undefined;
      runStartedAt = null;
      accountSpawnIndex = 0;
      accountAssignments.clear();
      cachedConfigMtime = 0;
      cachedModelRoutesMtime = 0;

      await hlog("cleanup_complete", {});

      pi.sendMessage(
        {
          customType: "run-cleanup",
          content:
            "Cleanup complete. All worktrees, branches, and state removed.",
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- Event Handlers ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    lastCtx = ctx;

    // Attempt to restore state
    const restored = await restoreState();
    if (restored && loopActive) {
      await hlog("session_restored", {
        sessions: sessions.size,
        pending: pendingTasks.length,
        merged: mergedWorkers.size,
      });
      ctx.ui.setStatus(`run: restored ${sessions.size} workers`);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!loopActive) return;
    cwd = ctx.cwd;
    lastCtx = ctx;

    // Reload config if changed
    await loadConfig();

    // Check stop signal
    try {
      await stat(resolve(cwd, STOP_SIGNAL_FILE));
      // Stop signal exists — graceful shutdown
      for (const [, session] of sessions) {
        if (session.tmuxSession) {
          await tmuxKillSession(session.tmuxSession);
        }
      }
      loopActive = false;
      await persistState();
      try {
        await rm(resolve(cwd, STOP_SIGNAL_FILE));
      } catch {
        /* already gone */
      }
      pi.sendMessage(
        {
          customType: "run-stopped",
          content: "Run stopped via stop signal.",
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    } catch {
      /* no stop signal — continue */
    }

    // Read all goal files
    const configs = await readAllGoalFiles();
    const configMap = new Map(configs.map((c) => [c.name, c]));

    // Count overall progress
    let totalGoals = 0;
    let completedGoals = 0;
    for (const config of configs) {
      totalGoals += config.goals.length;
      completedGoals += config.goals.filter((g) => g.completed).length;
    }

    // --- Auto-merge completed workers ---
    const mergeMessages: string[] = [];
    for (const [name, session] of Array.from(sessions)) {
      const config = configMap.get(name);
      if (!config) continue;

      const allDone =
        config.goals.length > 0 && config.goals.every((g) => g.completed);
      const unanswered = config.questions.filter((q) => !q.answered);

      if (allDone && unanswered.length === 0) {
        // Kill the worker tmux session first
        if (session.tmuxSession) {
          await tmuxKillSession(session.tmuxSession);
        }

        const result = await mergeWorktree(session);
        if (result.ok) {
          mergeMessages.push(`Auto-merged: ${name}`);
        } else {
          mergeMessages.push(`Merge failed: ${name} — ${result.message}`);
          await hlog(
            "merge_failed",
            { worker: name, error: result.message },
            "error",
          );
        }
      }
    }

    // Send merge notifications
    for (const msg of mergeMessages) {
      pi.sendMessage(
        { customType: "run-merge", content: msg, display: true },
        { triggerTurn: false },
      );
    }

    // --- Dispatch pending tasks ---
    if (pendingTasks.length > 0 && sessions.size < effectiveMaxWorkers) {
      const nowReady: PendingTask[] = [];
      const stillPending: PendingTask[] = [];

      for (const task of pendingTasks) {
        const unmetDeps = (task.dependsOn ?? []).filter(
          (d) => !mergedWorkers.has(d),
        );
        if (
          unmetDeps.length === 0 &&
          sessions.size + nowReady.length < effectiveMaxWorkers
        ) {
          nowReady.push(task);
        } else {
          stillPending.push(task);
        }
      }

      pendingTasks = stillPending;

      for (let i = 0; i < nowReady.length; i++) {
        const task = nowReady[i];
        try {
          const session = await createWorktree(task);

          // Stagger delay between spawns
          if (i > 0 && effectiveStaggerMs > 0) {
            await new Promise((r) => setTimeout(r, effectiveStaggerMs));
          }

          await spawnSession(session, task);
          pi.sendMessage(
            {
              customType: "run-dispatch",
              content: `Dispatched: ${task.name} [${getRole(task.role).label}] (deps satisfied)`,
              display: true,
            },
            { triggerTurn: false },
          );
          await hlog("task_dispatched", {
            worker: task.name,
            role: task.role,
          });
        } catch (err) {
          await hlog(
            "dispatch_error",
            { worker: task.name, error: String(err) },
            "error",
          );
        }
      }
    }

    // --- Worker activity monitoring ---
    for (const [name, session] of sessions) {
      if (!session.spawned || !session.tmuxSession) continue;

      const alive = await tmuxHasSession(session.tmuxSession);
      if (!alive) {
        // Dead worker detection
        const recoveryCount = session._recoveryCount ?? 0;
        if (recoveryCount < MAX_WORKER_RECOVERIES) {
          // Attempt recovery
          session._recoveryCount = recoveryCount + 1;
          const config = configMap.get(name);
          if (config) {
            const task: PendingTask = {
              name: config.name,
              role: config.role,
              goals: config.goals
                .filter((g) => !g.completed)
                .map((g) => g.text),
              context: config.context,
              dependsOn: config.dependsOn,
            };

            try {
              await spawnSession(session, task);
              await hlog("worker_recovered", {
                worker: name,
                attempt: session._recoveryCount,
              });
            } catch (err) {
              await hlog(
                "recovery_failed",
                { worker: name, error: String(err) },
                "error",
              );
            }
          }
        } else {
          await hlog(
            "worker_dead",
            { worker: name, maxRecoveries: MAX_WORKER_RECOVERIES },
            "error",
          );
        }
        continue;
      }

      // Stall detection
      const capture = await tmuxCapture(session.tmuxSession, 30);
      if (capture === session._lastCapture) {
        if (!session._stalledSince) {
          session._stalledSince = Date.now();
        } else if (
          Date.now() - session._stalledSince >
          WORKER_STALL_THRESHOLD_MS
        ) {
          await hlog(
            "worker_stalled",
            {
              worker: name,
              stalledMs: Date.now() - session._stalledSince,
            },
            "warn",
          );
        }
      } else {
        session._lastCapture = capture;
        session._stalledSince = null;
      }
    }

    // --- Terminal state check ---
    if (
      sessions.size === 0 &&
      pendingTasks.length === 0 &&
      mergedWorkers.size > 0
    ) {
      loopActive = false;

      const elapsed = runStartedAt
        ? Math.round((Date.now() - runStartedAt.getTime()) / 1000)
        : 0;
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;

      const completionMsg = [
        `## Run Complete`,
        "",
        `**Objective**: ${runObjective ?? "N/A"}`,
        `**Tasks completed**: ${mergedWorkers.size}`,
        `**Total goals**: ${totalGoals}`,
        `**Duration**: ${mins}m ${secs}s`,
        "",
        `Merged workers: ${Array.from(mergedWorkers).join(", ")}`,
      ].join("\n");

      pi.sendMessage(
        { customType: "run-complete", content: completionMsg, display: true },
        { triggerTurn: false },
      );

      await hlog("run_complete", {
        tasks: mergedWorkers.size,
        goals: totalGoals,
        durationSec: elapsed,
      });

      await persistState();
      return;
    }

    // --- Update status bar ---
    const activeCount = Array.from(sessions.values()).filter(
      (s) => s.spawned,
    ).length;
    const stalledCount = Array.from(sessions.values()).filter(
      (s) => s._stalledSince,
    ).length;
    const deadCount = 0; // already handled above
    ctx.ui.setStatus(
      `run: ${completedGoals}/${totalGoals} goals, ${activeCount}a/${stalledCount}s/${deadCount}d`,
    );

    await persistState();
  });

  pi.on("session_shutdown", async () => {
    if (loopActive || sessions.size > 0) {
      await persistState();
    }
  });
}
