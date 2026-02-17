/**
 * Submodule Launcher Extension for Pi
 *
 * Orchestrates parallel work across git submodules using git worktrees
 * for isolation. Each submodule session runs in its own worktree, driven
 * by goal files in `.pi-agent/`. A dedicated manager session monitors
 * worker progress, writes status to `.manager-status.json`, and auto-merges
 * completed branches. The parent session reads status passively.
 *
 * Worker Roles:
 *   Each worker can be assigned a role that shapes its behavioral persona
 *   and instructions. Roles are specified via `role:` in goal files or
 *   the `--role` flag when adding tasks.
 *
 *   developer   - (default) General implementation — features, bug fixes, TDD
 *   architect   - Refactoring, design patterns, API boundaries, code organization
 *   tester      - Test coverage — unit/integration/e2e tests, edge cases
 *   reviewer    - Code quality audit — bugs, security, performance, style
 *   researcher  - Exploration, prototyping, investigation, writing findings
 *   designer    - UI/UX implementation — components, user flows, accessibility
 *   builder     - Tooling & infrastructure — CI/CD, Docker, build configs
 *
 * Tools:
 *   harness_status      - LLM-callable progress check across all submodules
 *   harness_update_goal - Add/complete/remove goals for a submodule
 *   harness_add_task    - Create a standalone worktree task (AI-callable)
 *
 * Commands:
 *   /harness:launch    - Read goals, create worktrees, spawn workers + manager
 *   /harness:status    - Show progress of all submodules
 *   /harness:stop      - Write stop signal, deactivate loop
 *   /harness:init      - Discover submodules, scaffold .pi-agent/
 *   /harness:add       - Create a standalone worktree task (supports --role flag)
 *   /harness:merge     - Merge a specific submodule's worktree branch back
 *   /harness:recover   - Respawn stale/dead manager
 *   /harness:cleanup   - Remove all worktrees, branches, and state files
 *
 * Events:
 *   session_start      - Load config, restore state, read manager status
 *   turn_end           - Lightweight: read manager status, update status bar
 *   session_shutdown   - Persist state
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile, writeFile, readdir, mkdir, rm, rename, stat, copyFile } from "fs/promises";
import { join, resolve } from "path";
import {
  loadConfig as loadBmadConfig,
  loadStatus as loadBmadStatus,
  WORKFLOW_DEFS,
  WORKFLOW_PROMPTS,
  isCompleted as isBmadCompleted,
  buildContextBlock as bmadContextBlock,
  buildToolsBlock as bmadToolsBlock,
  buildCompletionBlock as bmadCompletionBlock,
  type BmadConfig,
  type WorkflowEntry,
} from "./bmad.js";

// --- Types ---

export interface SubmoduleGoal {
  text: string;
  completed: boolean;
}

export interface SubmoduleQuestion {
  text: string;
  answered: boolean;
  answer?: string;
}

export interface SubmoduleConfig {
  name: string;
  path: string;
  role: string;
  goals: SubmoduleGoal[];
  questions: SubmoduleQuestion[];
  context: string;
  rawContent: string;
  dependsOn?: string[];
}

export interface HarnessRole {
  name: string;
  label: string;
  persona: string;
  instructions: string[];
}

export const HARNESS_ROLES: HarnessRole[] = [
  {
    name: "developer",
    label: "Developer",
    persona: "a methodical software developer focused on clean, working code",
    instructions: [
      "Write tests first (red), then implementation (green), then refactor",
      "Commit incrementally after each meaningful change",
      "Follow existing code patterns and conventions in the repository",
      "Keep changes focused — avoid scope creep beyond the stated goals",
    ],
  },
  {
    name: "architect",
    label: "Architect",
    persona:
      "a software architect focused on structure, patterns, and maintainability",
    instructions: [
      "Focus on code organization, module boundaries, and clean interfaces",
      "Reduce duplication by extracting shared abstractions",
      "Ensure changes maintain backward compatibility where possible",
      "Document architectural decisions and rationale in code comments",
    ],
  },
  {
    name: "tester",
    label: "Tester",
    persona: "a quality engineer focused on comprehensive test coverage",
    instructions: [
      "Write thorough tests covering happy paths, edge cases, and error conditions",
      "Use the project's existing test framework and patterns",
      "Aim for high coverage of branches and boundary conditions",
      "Include both unit tests and integration tests where appropriate",
    ],
  },
  {
    name: "reviewer",
    label: "Reviewer",
    persona:
      "a code quality auditor focused on correctness, security, and performance",
    instructions: [
      "Systematically review code for bugs, security vulnerabilities, and performance issues",
      "Check for OWASP top 10 vulnerabilities and common security pitfalls",
      "Identify potential race conditions, memory leaks, and error handling gaps",
      "Create targeted fixes for each issue found, with clear commit messages",
    ],
  },
  {
    name: "researcher",
    label: "Researcher",
    persona:
      "a technical researcher focused on exploration, analysis, and documentation",
    instructions: [
      "Investigate approaches thoroughly before committing to a direction",
      "Read documentation, explore APIs, and prototype solutions",
      "Document findings, trade-offs, and recommendations in markdown files",
      "Focus on understanding before implementation",
    ],
  },
  {
    name: "designer",
    label: "Designer",
    persona:
      "a frontend developer focused on UI/UX quality and user experience",
    instructions: [
      "Prioritize user experience, accessibility (WCAG 2.1 AA), and responsive design",
      "Follow the project's design system and component patterns",
      "Test across viewport sizes and interaction modes",
      "Write semantic HTML and maintain consistent styling",
    ],
  },
  {
    name: "builder",
    label: "Builder",
    persona:
      "a platform engineer focused on tooling, automation, and developer experience",
    instructions: [
      "Focus on CI/CD pipelines, build configurations, and development tooling",
      "Automate repetitive processes and improve developer workflow",
      "Ensure configs are reproducible and well-documented",
      "Test infrastructure changes in isolation before merging",
    ],
  },
  {
    name: "analyst",
    label: "Analyst",
    persona:
      "a business analyst focused on product vision, market analysis, and requirements discovery",
    instructions: [
      "Synthesize domain knowledge into clear, actionable documents",
      "Focus on clarity and completeness — capture all stakeholder needs",
      "Reference prior documents and completed workflows for continuity",
      "Save deliverables via BMAD tools (bmad_save_document, bmad_update_status)",
    ],
  },
  {
    name: "planner",
    label: "Planner",
    persona:
      "a project planner focused on decomposing work into actionable stories and sprint plans",
    instructions: [
      "Break epics into well-defined, estimable user stories",
      "Estimate effort using Fibonacci story points and define dependencies",
      "Create clear sprint plans with capacity-aware allocation",
      "Save deliverables via BMAD tools (bmad_save_document, bmad_update_status)",
    ],
  },
];

export function getRole(name: string): HarnessRole {
  return HARNESS_ROLES.find((r) => r.name === name) ?? HARNESS_ROLES[0];
}

/** Maps BMAD agent names to harness role names. */
/** Prefix for all BMAD worker names (e.g., "bmad-prd", "bmad-architecture"). */
export const BMAD_PREFIX = "bmad-";

export const BMAD_ROLE_MAP: Record<string, string> = {
  "Business Analyst": "analyst",
  "Creative Intelligence": "researcher",
  "Product Manager": "researcher",
  "UX Designer": "designer",
  "System Architect": "architect",
  "Scrum Master": "planner",
  Developer: "developer",
  Builder: "builder",
};

// --- BMAD DAG Types & Builder ---

export interface BmadGoalSpec {
  workflowName: string;
  phase: number;
  role: string;
  bmadAgent: string;
  dependsOn: string[];
  goals: string[];
}

/** Hardcoded dependency edges for BMAD workflows. */
const BMAD_DEPENDENCY_MAP: Record<string, string[]> = {
  "product-brief": [],
  brainstorm: [],
  research: [],
  prd: ["product-brief"],
  "tech-spec": ["product-brief"],
  "create-ux-design": ["prd"],
  architecture: ["prd", "tech-spec"],
  "solutioning-gate-check": ["architecture"],
  "sprint-planning": ["architecture", "tech-spec"],
  "create-story": ["sprint-planning"],
  "dev-story": ["create-story"],
};

/** Workflow sets by project level. */
function getWorkflowsForLevel(level: number): string[] {
  const base =
    level === 0
      ? ["tech-spec", "sprint-planning", "create-story", "dev-story"]
      : level === 1
        ? ["product-brief", "tech-spec", "sprint-planning", "create-story", "dev-story"]
        : [
            "product-brief",
            "prd",
            "architecture",
            "sprint-planning",
            "create-story",
            "dev-story",
          ];

  // Add optional workflows based on level
  if (level >= 1) base.push("brainstorm", "research");
  if (level >= 2) base.push("create-ux-design", "solutioning-gate-check");

  return base;
}

/**
 * Build a dependency DAG of BMAD workflows filtered by project level and
 * completion status. Pure function — no side effects.
 */
export function buildBmadWorkflowDag(
  level: number,
  currentStatus: Array<{ name: string; status: string }>,
  workflowDefs: Array<{
    name: string;
    phase: number;
    agent: string;
    description: string;
  }>,
): BmadGoalSpec[] {
  const targetWorkflows = getWorkflowsForLevel(level);
  const defNames = new Set(workflowDefs.map((d) => d.name));

  // Validate that all target workflows exist in workflowDefs
  const missing = targetWorkflows.filter((w) => !defNames.has(w));
  if (missing.length > 0) {
    throw new Error(
      `getWorkflowsForLevel(${level}) references workflows not in workflowDefs: ${missing.join(", ")}`,
    );
  }

  // Build a lookup of completed workflows (single source of truth: isBmadCompleted)
  const completedSet = new Set(
    currentStatus
      .filter((e) => isBmadCompleted(e.status))
      .map((e) => e.name),
  );

  const specs: BmadGoalSpec[] = [];

  for (const name of targetWorkflows) {
    if (completedSet.has(name)) continue;

    // Safe: validated above that all target workflows exist in workflowDefs
    const def = workflowDefs.find((d) => d.name === name)!;

    // Filter dependency edges to only include workflows that are in this plan
    const rawDeps = BMAD_DEPENDENCY_MAP[name] ?? [];
    const deps = rawDeps.filter(
      (d) => targetWorkflows.includes(d) && !completedSet.has(d),
    );

    const role = BMAD_ROLE_MAP[def.agent] ?? "developer";

    specs.push({
      workflowName: name,
      phase: def.phase,
      role,
      bmadAgent: def.agent,
      dependsOn: deps,
      goals: [`Complete the ${name} workflow: ${def.description}`],
    });
  }

  return specs;
}

export interface SubmoduleSession {
  name: string;
  worktreePath: string;
  branch: string;
  spawned: boolean;
  spawnedAt: Date | null;
  tmuxSession: string | null;
  _lastCapture?: string;
  _stalledSince?: number | null;
}

export interface LaunchState {
  active: boolean;
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
  managerSpawned: boolean;
  managerCwd: string;
  managerSpawnedAt: string | null;
  managerTmuxSession: string | null;
}

export interface RunSummary {
  startedAt: string;
  stoppedAt: string;
  duration: string;
  stopReason: "user_stop" | "all_complete" | "stalled" | "error";
  workers: Record<
    string,
    {
      role: string;
      commits: number;
      goalsTotal: number;
      goalsCompleted: number;
      filesChanged: number;
      branch: string;
      merged: boolean;
    }
  >;
  mailboxUnprocessed: number;
  queueItemsPending: number;
}

export const SUMMARY_FILE = ".pi-agent/.summary.json";

export interface ManagerStatusFile {
  status: "running" | "stalled" | "all_complete" | "stopped" | "error";
  updatedAt: string;
  submodules: Record<
    string,
    {
      completed: number;
      total: number;
      allDone: boolean;
      unansweredQuestions?: number;
    }
  >;
  mergeResults?: string[];
  stallCount: number;
  message?: string;
}

// --- Constants ---

export const MAX_STALLS = 5;
export const CONTEXT_CRITICAL_PERCENT = 90;
export const PI_AGENT_DIR = ".pi-agent";
export const WORKTREE_DIR = ".pi-agent/worktrees";
export const LAUNCH_STATE_FILE = ".pi-agent/.launch-state.json";
export const MANAGER_DIR = ".pi-agent/.manager";
export const MANAGER_STATUS_FILE = ".pi-agent/.manager-status.json";
export const STOP_SIGNAL_FILE = ".pi-agent/.stop-signal";
export const MANAGER_STALE_THRESHOLD_MS = 5 * 60 * 1000;
export const MAILBOX_DIR = ".pi-agent/.mailboxes";
export const QUEUE_FILE = ".pi-agent/.queue.json";
export const REGISTRY_FILE = ".pi-agent/.registry.json";

export const TMUX_SERVER = "pi-harness";
export const MAX_CONSECUTIVE_FAILURES = 5;
export const WORKER_STALL_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
export const RECOVERY_BACKOFF = [2, 4, 8]; // stale cycles required for each recovery attempt

export interface WorkerState {
  name: string;
  status: "active" | "stalled" | "completed" | "error";
  goalsCompleted: number;
  goalsTotal: number;
  lastActivity: string;
  errors: string[];
  mergeStatus: "pending" | "merged" | "conflict" | null;
  dependsOn: string[];
  dependenciesMet: boolean;
}

// --- Validation Schemas (Typebox) ---

const WorkerStateSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("stalled"), Type.Literal("completed"), Type.Literal("error")]),
  goalsCompleted: Type.Number(),
  goalsTotal: Type.Number(),
  lastActivity: Type.String(),
  errors: Type.Array(Type.String()),
  mergeStatus: Type.Union([Type.Literal("pending"), Type.Literal("merged"), Type.Literal("conflict"), Type.Null()]),
  dependsOn: Type.Array(Type.String()),
  dependenciesMet: Type.Boolean(),
});

const LaunchStateSchema = Type.Object({
  active: Type.Boolean(),
  sessions: Type.Record(
    Type.String(),
    Type.Object({
      worktreePath: Type.String(),
      branch: Type.String(),
      spawned: Type.Boolean(),
      spawnedAt: Type.Union([Type.String(), Type.Null()]),
      tmuxSession: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  managerSpawned: Type.Boolean(),
  managerCwd: Type.String(),
  managerSpawnedAt: Type.Union([Type.String(), Type.Null()]),
  managerTmuxSession: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const ManagerStatusSchema = Type.Object({
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("stalled"),
    Type.Literal("all_complete"),
    Type.Literal("stopped"),
    Type.Literal("error"),
  ]),
  updatedAt: Type.String(),
  submodules: Type.Record(
    Type.String(),
    Type.Object({
      completed: Type.Number(),
      total: Type.Number(),
      allDone: Type.Boolean(),
      unansweredQuestions: Type.Optional(Type.Number()),
    }),
  ),
  stallCount: Type.Number(),
  mergeResults: Type.Optional(Type.Array(Type.String())),
  message: Type.Optional(Type.String()),
});

// --- Mailbox / Queue / Registry Types ---

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  type:
    | "directive"
    | "status_report"
    | "question"
    | "answer"
    | "work_dispatch"
    | "ack";
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface QueueItem {
  id: string;
  topic: string;
  description: string;
  goals?: string[];
  role?: string;
  priority: number;
  status: "pending" | "dispatched" | "completed";
  assignedTo?: string;
  createdAt: string;
  dispatchedAt?: string;
}

export interface WorkQueue {
  items: QueueItem[];
}

export interface WorkerRegistryEntry {
  name: string;
  role: string;
  branch: string;
  worktreePath: string;
  status: "active" | "idle" | "stalled" | "completed";
  goalsTotal: number;
  goalsCompleted: number;
  lastHeartbeat?: string;
  assignedQueueItems: string[];
}

export interface WorkerRegistry {
  workers: Record<string, WorkerRegistryEntry>;
  updatedAt: string;
}

const MailboxMessageSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.String(),
  type: Type.Union([
    Type.Literal("directive"),
    Type.Literal("status_report"),
    Type.Literal("question"),
    Type.Literal("answer"),
    Type.Literal("work_dispatch"),
    Type.Literal("ack"),
  ]),
  timestamp: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

const QueueItemSchema = Type.Object({
  id: Type.String(),
  topic: Type.String(),
  description: Type.String(),
  goals: Type.Optional(Type.Array(Type.String())),
  role: Type.Optional(Type.String()),
  priority: Type.Number(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("dispatched"),
    Type.Literal("completed"),
  ]),
  assignedTo: Type.Optional(Type.String()),
  createdAt: Type.String(),
  dispatchedAt: Type.Optional(Type.String()),
});

const WorkQueueSchema = Type.Object({
  items: Type.Array(QueueItemSchema),
});

const WorkerRegistryEntrySchema = Type.Object({
  name: Type.String(),
  role: Type.String(),
  branch: Type.String(),
  worktreePath: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("idle"),
    Type.Literal("stalled"),
    Type.Literal("completed"),
  ]),
  goalsTotal: Type.Number(),
  goalsCompleted: Type.Number(),
  lastHeartbeat: Type.Optional(Type.String()),
  assignedQueueItems: Type.Array(Type.String()),
});

const WorkerRegistrySchema = Type.Object({
  workers: Type.Record(Type.String(), WorkerRegistryEntrySchema),
  updatedAt: Type.String(),
});

// --- Shared Helpers ---

/** Escape a string for safe embedding in a single-quoted shell argument. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Sanitize a string for use as a tmux session name. */
export function sanitizeTmuxName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
}

/** Derive goal filename from a config/task name. Single source of truth. */
export function goalFileName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-") + ".md";
}

/** Write file atomically: write to temp, then rename (POSIX-atomic). */
let atomicCounter = 0;
async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tmp = filePath + `.tmp.${process.pid}.${++atomicCounter}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

/**
 * Tiered fuzzy match: exact → starts-with → substring.
 * Returns the single match, or null if zero or ambiguous matches.
 */
export function fuzzyMatchOne<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
): { match: T } | { ambiguous: T[] } | null {
  const q = query.toLowerCase();

  // Tier 1: exact match
  const exact = items.filter((item) => getText(item).toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  // Tier 2: starts-with match
  const startsWith = items.filter((item) =>
    getText(item).toLowerCase().startsWith(q),
  );
  if (startsWith.length === 1) return { match: startsWith[0] };
  if (startsWith.length > 1) return { ambiguous: startsWith };

  // Tier 3: substring match (query contained in item text)
  const substring = items.filter((item) => {
    const t = getText(item).toLowerCase();
    return t.includes(q);
  });
  if (substring.length === 1) return { match: substring[0] };
  if (substring.length > 1) return { ambiguous: substring };

  return null;
}

// --- Mailbox / Queue / Registry Helpers ---

/** Generate a unique message ID: "{timestamp}-{4 random chars}" */
export function generateMessageId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${Date.now()}-${suffix}`;
}

/** Resolve the mailbox directory for an actor. */
export function mailboxPath(baseCwd: string, actor: string): string {
  return join(baseCwd, MAILBOX_DIR, actor);
}

/** Write a message file to a recipient's mailbox directory. */
export async function sendMailboxMessage(
  baseCwd: string,
  to: string,
  from: string,
  type: MailboxMessage["type"],
  payload: Record<string, unknown>,
): Promise<string> {
  const id = generateMessageId();
  const msg: MailboxMessage = {
    id,
    from,
    to,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
  const dir = mailboxPath(baseCwd, to);
  await mkdir(dir, { recursive: true });
  const filename = `${id}.json`;
  await atomicWriteFile(join(dir, filename), JSON.stringify(msg, null, 2) + "\n");
  return id;
}

/** Read all messages from an actor's mailbox, sorted chronologically. */
export async function readMailbox(
  baseCwd: string,
  actor: string,
): Promise<Array<{ message: MailboxMessage; filename: string }>> {
  const dir = mailboxPath(baseCwd, actor);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const results: Array<{ message: MailboxMessage; filename: string }> = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(dir, file), "utf-8");
      const parsed = JSON.parse(content);
      if (Value.Check(MailboxMessageSchema, parsed)) {
        results.push({ message: parsed as MailboxMessage, filename: file });
      }
    } catch {
      // Skip malformed messages
    }
  }
  return results;
}

/** Delete a processed message from an actor's mailbox. */
export async function deleteMessage(
  baseCwd: string,
  actor: string,
  filename: string,
): Promise<void> {
  try {
    await rm(join(mailboxPath(baseCwd, actor), filename));
  } catch {
    // Already deleted or doesn't exist
  }
}

/** Advisory file lock for queue read-modify-write sequences. */
export async function withQueueLock<T>(baseCwd: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(baseCwd, QUEUE_FILE + ".lock");
  for (let i = 0; i < 5; i++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      try {
        return await fn();
      } finally {
        await rm(lockPath).catch(() => {});
      }
    } catch {
      await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
  }
  // Fallback: proceed without lock rather than blocking forever
  return fn();
}

/** Read the work queue. Returns empty queue if file doesn't exist. */
export async function readQueue(baseCwd: string): Promise<WorkQueue> {
  try {
    const content = await readFile(join(baseCwd, QUEUE_FILE), "utf-8");
    const parsed = JSON.parse(content);
    if (Value.Check(WorkQueueSchema, parsed)) {
      return parsed as WorkQueue;
    }
  } catch {
    // File doesn't exist or is malformed
  }
  return { items: [] };
}

/** Atomically write the work queue. */
export async function writeQueue(
  baseCwd: string,
  queue: WorkQueue,
): Promise<void> {
  await mkdir(join(baseCwd, PI_AGENT_DIR), { recursive: true });
  await atomicWriteFile(
    join(baseCwd, QUEUE_FILE),
    JSON.stringify(queue, null, 2) + "\n",
  );
}

/** Read the worker registry. Returns null if absent. */
export async function readRegistry(
  baseCwd: string,
): Promise<WorkerRegistry | null> {
  try {
    const content = await readFile(join(baseCwd, REGISTRY_FILE), "utf-8");
    const parsed = JSON.parse(content);
    if (Value.Check(WorkerRegistrySchema, parsed)) {
      return parsed as WorkerRegistry;
    }
  } catch {
    // File doesn't exist or is malformed
  }
  return null;
}

/** Atomically write the worker registry. */
export async function writeRegistry(
  baseCwd: string,
  registry: WorkerRegistry,
): Promise<void> {
  await mkdir(join(baseCwd, PI_AGENT_DIR), { recursive: true });
  await atomicWriteFile(
    join(baseCwd, REGISTRY_FILE),
    JSON.stringify(registry, null, 2) + "\n",
  );
}

// --- Pure Functions ---

export function parseGoalFile(
  content: string,
  filename: string,
): SubmoduleConfig {
  const lines = content.split("\n");

  // Extract name from # heading, fallback to filename.
  // Normalize to lowercase kebab-case to match goalFileName() output.
  let name = filename.replace(/\.md$/, "");
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    name = headingMatch[1].trim();
  }
  name = name.toLowerCase().replace(/\s+/g, "-");

  // Extract path from "path:" field (default to "." for standalone worktrees)
  let path = ".";
  const pathMatch = content.match(/^path:\s*(.+)$/m);
  if (pathMatch) {
    path = pathMatch[1].trim();
  }

  // Extract role from "role:" field (default to "developer")
  let role = "developer";
  const roleMatch = content.match(/^role:\s*(.+)$/m);
  if (roleMatch) {
    const parsed = roleMatch[1].trim().toLowerCase();
    if (HARNESS_ROLES.some((r) => r.name === parsed)) {
      role = parsed;
    }
  }

  // Extract goals from ## Goals section
  const goals: SubmoduleGoal[] = [];
  let inGoals = false;
  for (const line of lines) {
    if (/^##\s+Goals/i.test(line)) {
      inGoals = true;
      continue;
    }
    if (inGoals && /^##\s+/.test(line)) {
      inGoals = false;
      continue;
    }
    if (inGoals) {
      const goalMatch = line.match(/^- \[([ xX])\] (.+)$/);
      if (goalMatch) {
        goals.push({
          text: goalMatch[2].trim(),
          completed: goalMatch[1].toLowerCase() === "x",
        });
      }
    }
  }

  // Extract questions from ## Questions section
  const questions: SubmoduleQuestion[] = [];
  let inQuestions = false;
  for (const line of lines) {
    if (/^##\s+Questions/i.test(line)) {
      inQuestions = true;
      continue;
    }
    if (inQuestions && /^##\s+/.test(line)) {
      inQuestions = false;
      continue;
    }
    if (inQuestions) {
      // Answered: - ! question text → answer text
      const answeredMatch = line.match(/^- ! (.+?) → (.+)$/);
      if (answeredMatch) {
        questions.push({
          text: answeredMatch[1].trim(),
          answered: true,
          answer: answeredMatch[2].trim(),
        });
        continue;
      }
      // Unanswered: - ? question text
      const unansweredMatch = line.match(/^- \? (.+)$/);
      if (unansweredMatch) {
        questions.push({
          text: unansweredMatch[1].trim(),
          answered: false,
        });
      }
    }
  }

  // Extract depends_on from "depends_on:" field
  let dependsOn: string[] | undefined;
  const dependsMatch = content.match(/^depends_on:\s*(.+)$/m);
  if (dependsMatch) {
    dependsOn = dependsMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  }

  // Extract context from ## Context section
  let context = "";
  let inContext = false;
  const contextLines: string[] = [];
  for (const line of lines) {
    if (/^##\s+Context/i.test(line)) {
      inContext = true;
      continue;
    }
    if (inContext && /^##\s+/.test(line)) {
      inContext = false;
      continue;
    }
    if (inContext) {
      contextLines.push(line);
    }
  }
  context = contextLines.join("\n").trim();

  return { name, path, role, goals, questions, context, rawContent: content, dependsOn };
}

export function serializeGoalFile(config: SubmoduleConfig): string {
  const lines: string[] = [];
  lines.push(`# ${config.name}`);
  lines.push(`path: ${config.path}`);
  if (config.role && config.role !== "developer") {
    lines.push(`role: ${config.role}`);
  }
  if (config.dependsOn && config.dependsOn.length > 0) {
    lines.push(`depends_on: ${config.dependsOn.join(", ")}`);
  }
  lines.push("");
  lines.push("## Goals");
  for (const goal of config.goals) {
    const check = goal.completed ? "x" : " ";
    lines.push(`- [${check}] ${goal.text}`);
  }
  if (config.questions && config.questions.length > 0) {
    lines.push("");
    lines.push("## Questions");
    for (const q of config.questions) {
      if (q.answered && q.answer) {
        lines.push(`- ! ${q.text} → ${q.answer}`);
      } else {
        lines.push(`- ? ${q.text}`);
      }
    }
  }
  if (config.context) {
    lines.push("");
    lines.push("## Context");
    lines.push(config.context);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildProgressSummary(configs: SubmoduleConfig[]): string {
  const lines: string[] = [];
  lines.push("## Submodule Launch: Progress Report");
  lines.push("");

  let allComplete = true;
  for (const config of configs) {
    const total = config.goals.length;
    const done = config.goals.filter((g) => g.completed).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const status = done === total ? "DONE" : `${done}/${total}`;
    const roleTag =
      config.role && config.role !== "developer"
        ? ` [${getRole(config.role).label}]`
        : "";
    lines.push(`### ${config.name}${roleTag} (${status}, ${pct}%)`);

    for (const goal of config.goals) {
      const check = goal.completed ? "x" : " ";
      lines.push(`- [${check}] ${goal.text}`);
    }

    const unanswered = config.questions?.filter((q) => !q.answered) ?? [];
    const answered = config.questions?.filter((q) => q.answered) ?? [];
    if (unanswered.length > 0) {
      for (const q of unanswered) {
        lines.push(`- ? ${q.text}`);
      }
    }
    if (answered.length > 0) {
      lines.push(`(${answered.length} question(s) answered)`);
    }
    lines.push("");

    if (done < total) allComplete = false;
  }

  if (allComplete) {
    lines.push("**All submodule goals are complete!**");
  } else {
    lines.push(
      "Continue monitoring submodule progress. Check for stalled sessions.",
    );
  }

  return lines.join("\n");
}

/** Build static manager instructions (written once at launch). */
export interface BmadModeConfig {
  projectLevel: number;
  projectName: string;
  statusFile: string;
  maxWorkers?: number;
  workflows: Array<{
    name: string;
    workflowName: string;
    phase: number;
    dependsOn: string[];
  }>;
}

export function buildManagerInstructions(
  configs: SubmoduleConfig[],
  baseCwd: string,
  bmadMode?: BmadModeConfig,
): string {
  const piAgentPath = resolve(baseCwd, PI_AGENT_DIR);
  const statusFilePath = resolve(baseCwd, MANAGER_STATUS_FILE);
  const stopSignalPath = resolve(baseCwd, STOP_SIGNAL_FILE);

  // Build role awareness section
  const roleSummaries: string[] = [];
  for (const config of configs) {
    const role = getRole(config.role);
    roleSummaries.push(`- **${config.name}** — ${role.label}: ${role.persona}`);
  }

  return [
    "You are the Launch Manager for a multi-submodule development orchestration.",
    "You are invoked in a loop. Complete one full cycle of checks and updates, then exit cleanly.",
    "",
    "## Your Job",
    "Monitor worker sessions across submodules, track their progress, and auto-merge completed branches.",
    "",
    "## Worker Roles",
    "Each worker has a specialized role that determines how they approach their goals:",
    ...roleSummaries,
    "",
    "On each heartbeat cycle, consider each worker's role when evaluating progress:",
    "- **Architects** may take longer on individual goals but produce structural improvements — don't flag as stalled prematurely",
    "- **Testers** should be producing test files — check for test coverage artifacts",
    "- **Reviewers** should be creating targeted fix commits — look for review/audit output",
    "- **Researchers** should be producing documentation or findings — check for markdown output",
    "- **Designers** should be focused on UI/UX files — check for component changes",
    "- **Builders** should be modifying CI/CD and tooling configs — check for infrastructure files",
    "- **Developers** follow standard TDD workflow — expect incremental commits",
    "",
    "When a new worker is launched mid-session, read its goal file to understand its role and dispatch",
    "role-appropriate guidance: remind architects to document decisions, remind testers to cover edge cases,",
    "remind reviewers to check OWASP top 10, etc.",
    "",
    "## Instructions",
    "Every heartbeat cycle:",
    `0. FIRST: Read your mailbox at \`${resolve(baseCwd, MAILBOX_DIR, "manager")}/\` and process all messages before doing anything else`,
    `1. Read each *.md goal file from \`${piAgentPath}\``,
    "2. Count completed vs total goals for each submodule",
    "3. Check for any new goal files that weren't present in the previous cycle (new workers launched)",
    "   - For new workers: note their role and include role-specific guidance in the status message",
    `4. Write status to \`${statusFilePath}\` as JSON:`,
    "   ```json",
    "   {",
    '     "status": "running|stalled|all_complete|stopped|error",',
    '     "updatedAt": "<ISO timestamp>",',
    '     "submodules": { "<name>": { "completed": N, "total": N, "allDone": bool, "unansweredQuestions": N } },',
    '     "stallCount": N,',
    '     "message": "<human-readable status>"',
    "   }",
    "   ```",
    `5. Check for \`${stopSignalPath}\` — if present, write final status with status: "stopped" and exit`,
    '6. If all goals are complete across all submodules AND all questions are answered, set status to "all_complete", auto-merge branches, and exit',
    "7. Track progress: if no goals change between cycles, increment stallCount",
    "   - **Exception**: workers with unanswered questions (- ? lines in their goal file) are NOT stalled — they are waiting for user input",
    "   - Include `unansweredQuestions` count per submodule in the status file",
    `8. If stallCount reaches ${MAX_STALLS}, set status to "stalled" and exit`,
    "9. Check `depends_on` headers in goal files. Do not dispatch queued items whose dependencies are incomplete.",
    "",
    "## Auto-Merge",
    "When all goals for a submodule are complete AND it has no unanswered questions, merge its worktree branch back:",
    "- **Do NOT merge** if the submodule has any unanswered questions (- ? lines), even if all goals are complete",
    `- Run \`git merge <branch> --no-edit\` from the submodule's path under \`${baseCwd}\``,
    `- Run \`git worktree remove <worktree-path>\` from \`${baseCwd}\``,
    `- Run \`git branch -d <branch>\` from \`${baseCwd}\``,
    "- Record results in the mergeResults array of the status file",
    "",
    "## Important",
    "- Always write the status file after each check, even if nothing changed — the parent uses updatedAt to detect liveness",
    "- If you encounter errors reading files or executing commands, write a status_report to the parent mailbox describing the issue",
    "- Use the updatedAt timestamp so the parent can detect liveness",
    "- Exit gracefully when stop signal is found, all goals are complete, or stall limit is reached",
    "",
    "## Work Queue",
    `On each heartbeat cycle, read \`${resolve(baseCwd, QUEUE_FILE)}\` for pending work items.`,
    "For each item with status \"pending\":",
    "- Match the item's role (if any) against available workers, or pick a worker with capacity",
    "- Update the item's status to \"dispatched\" and set assignedTo to the worker name",
    "- Add the item's goals to the worker's goal file",
    "- Send a work_dispatch message to the worker's mailbox at `.pi-agent/.mailboxes/{worker}/`",
    "- Write the updated queue back to the file",
    "",
    "## Mailbox",
    `Your inbox is at \`${resolve(baseCwd, MAILBOX_DIR, "manager")}/\`.`,
    "On each heartbeat cycle, read all *.json files in your inbox directory, sorted by filename.",
    "Process each message by type:",
    "- **directive**: Execute the instruction or dispatch work accordingly",
    "- **status_report**: Note worker progress, update registry",
    "- **question**: Forward to parent mailbox at `.pi-agent/.mailboxes/parent/` if you cannot answer",
    "- **ack**: Note acknowledgment",
    "After processing each message, delete the file (deletion = acknowledgment).",
    "To send a message, write a JSON file to `.pi-agent/.mailboxes/{recipient}/` with this schema:",
    '```json',
    '{ "id": "<timestamp>-<4chars>", "from": "manager", "to": "<recipient>",',
    '  "type": "<message_type>", "timestamp": "<ISO 8601>", "payload": { ... } }',
    '```',
    "",
    "## Worker Registry",
    `Maintain \`${resolve(baseCwd, REGISTRY_FILE)}\` with worker status on each heartbeat.`,
    "Update each worker's entry with: status, goalsTotal, goalsCompleted, lastHeartbeat, assignedQueueItems.",
    "The parent reads this file for display purposes.",
    ...(bmadMode
      ? [
          "",
          "## BMAD Phase Management",
          "",
          `This is a BMAD orchestration run for **${bmadMode.projectName}** (Level ${bmadMode.projectLevel}).`,
          `The BMAD mode metadata file is at \`${resolve(baseCwd, PI_AGENT_DIR, ".bmad-mode.json")}\`.`,
          `Max concurrent workers: ${bmadMode.maxWorkers ?? "unlimited"}.`,
          "",
          "After auto-merging any `bmad-*` worker:",
          `1. Read \`${resolve(baseCwd, PI_AGENT_DIR, ".bmad-mode.json")}\` and mark the merged workflow's status as \`"completed"\``,
          "2. Check for newly-unblocked workflows: a workflow is unblocked when **every** entry in its `dependsOn`",
          "   array has status `\"completed\"` in the `.bmad-mode.json` workflows list.",
          "   NOTE: A dependency that is NOT listed in `.bmad-mode.json` at all is considered satisfied",
          "   (it was either completed before launch or not part of this project level).",
          `3. Count currently active workers (status \`"active"\` in .bmad-mode.json). Only spawn new workers if below the max.`,
          "4. For each unblocked workflow (respecting max workers):",
          `   - \`git worktree add ${resolve(baseCwd, WORKTREE_DIR)}/bmad-{name} -b pi-agent/bmad-{name}\``,
          `   - Copy pre-generated prompt: \`cp ${resolve(baseCwd, PI_AGENT_DIR, ".prompts")}/bmad-{name}.md\` → worktree \`.pi-agent-prompt.md\``,
          "   - Write heartbeat.md to the worktree (use the goal file content to build it)",
          "   - Add heartbeat.md and .pi-agent-prompt.md to the worktree's git exclude file",
          `   - Spawn tmux: \`tmux -L ${TMUX_SERVER} new-session -d -s worker-bmad-{name} 'pi -p "$(cat .pi-agent-prompt.md)"'\``,
          `   - Update .bmad-mode.json: set this workflow's status to \`"active"\``,
          `   - **Add the new worker to the registry** at \`${resolve(baseCwd, REGISTRY_FILE)}\`:`,
          "     ```json",
          '     { "name": "bmad-{name}", "status": "active", "goalsTotal": 1, "goalsCompleted": 0,',
          '       "lastHeartbeat": "<ISO 8601>", "assignedQueueItems": [] }',
          "     ```",
          `5. Write the updated .bmad-mode.json back to disk`,
          "",
          "**Dev-story fan-out:** When `bmad-create-story` merges, scan `docs/stories/STORY-*.md`.",
          "For each story file, create a separate `bmad-dev-story-{id}` worker following the same pattern above.",
          "Each dev-story worker should implement that specific story end-to-end.",
          "Add each dev-story worker to both `.bmad-mode.json` (as a new workflow entry) and the registry.",
          "",
          "**Staleness detection:** BMAD workers follow the same heartbeat staleness rules as regular workers.",
          "If a `bmad-*` worker's tmux session dies or its heartbeat goes stale, attempt recovery as you would for any worker.",
        ]
      : []),
  ].join("\n");
}

/** Build dynamic manager prompt (written each cycle, references static instructions). */
export function buildManagerPrompt(
  configs: SubmoduleConfig[],
  sessionEntries: Array<{
    name: string;
    branch: string;
    worktreePath: string;
  }>,
  baseCwd: string,
): string {
  const sessionMap = new Map(sessionEntries.map((s) => [s.name, s]));

  const goalSections: string[] = [];
  for (const config of configs) {
    const goalList = config.goals
      .map((g) => `- [${g.completed ? "x" : " "}] ${g.text}`)
      .join("\n");
    const session = sessionMap.get(config.name);
    const branchInfo = session
      ? `Branch: \`${session.branch}\`, Worktree: \`${session.worktreePath}\``
      : "No active session";
    const roleInfo =
      config.role && config.role !== "developer"
        ? `Role: ${getRole(config.role).label}`
        : "";
    const unanswered = config.questions?.filter((q) => !q.answered) ?? [];
    const questionLines: string[] = [];
    if (unanswered.length > 0) {
      questionLines.push(`Unanswered questions (${unanswered.length}):`);
      for (const q of unanswered) {
        questionLines.push(`  - ? ${q.text}`);
      }
    }
    const depsInfo = config.dependsOn?.length
      ? `Depends on: ${config.dependsOn.join(", ")}`
      : "";

    goalSections.push(
      [
        `### ${config.name}`,
        `Path: ${config.path}`,
        ...(roleInfo ? [roleInfo] : []),
        ...(depsInfo ? [depsInfo] : []),
        branchInfo,
        "",
        goalList,
        ...questionLines,
      ].join("\n"),
    );
  }

  return [
    "Read your full instructions from `.pi-agent/.manager-instructions.md`.",
    "",
    "## Current Submodules",
    ...goalSections,
  ].join("\n");
}

export async function readManagerStatus(
  baseCwd: string,
): Promise<ManagerStatusFile | null> {
  try {
    const content = await readFile(join(baseCwd, MANAGER_STATUS_FILE), "utf-8");
    const parsed = JSON.parse(content);
    if (!Value.Check(ManagerStatusSchema, parsed)) {
      return null;
    }
    return parsed as ManagerStatusFile;
  } catch {
    return null;
  }
}

// --- Tool Schemas ---

const UpdateGoalParams = Type.Object({
  submodule: Type.String({
    description: "Submodule name (matches filename or # heading)",
  }),
  action: Type.Union(
    [Type.Literal("add"), Type.Literal("complete"), Type.Literal("remove")],
    { description: "Action: 'add', 'complete', or 'remove'" },
  ),
  goal: Type.String({ description: "Goal text to add, complete, or remove" }),
});

type UpdateGoalInput = Static<typeof UpdateGoalParams>;

const AddTaskParams = Type.Object({
  name: Type.String({
    description: "Task name (used as filename and branch name, kebab-case)",
  }),
  goals: Type.Array(Type.String(), {
    description: "List of goals for this task",
  }),
  context: Type.Optional(
    Type.String({ description: "Context for the worker agent" }),
  ),
  path: Type.Optional(
    Type.String({ description: "Subdirectory focus (default: '.')" }),
  ),
  role: Type.Optional(
    Type.String({
      description:
        "Worker role: developer (default), architect, tester, reviewer, researcher, designer, builder",
    }),
  ),
});

type AddTaskInput = Static<typeof AddTaskParams>;

const AskParams = Type.Object({
  submodule: Type.String({
    description: "Submodule name (matches filename or # heading)",
  }),
  question: Type.String({ description: "Question to stage for the user" }),
});

type AskInput = Static<typeof AskParams>;

const AnswerParams = Type.Object({
  submodule: Type.String({
    description: "Submodule name (matches filename or # heading)",
  }),
  question: Type.String({
    description:
      "Question text to match (fuzzy match against unanswered questions)",
  }),
  answer: Type.String({ description: "Answer to provide" }),
});

type AnswerInput = Static<typeof AnswerParams>;

const QueueToolParams = Type.Object({
  topic: Type.String({ description: "Topic/name for the queue item" }),
  description: Type.Optional(
    Type.String({ description: "Description of the work" }),
  ),
  goals: Type.Optional(
    Type.Array(Type.String(), { description: "Goals for the queued work" }),
  ),
  role: Type.Optional(
    Type.String({ description: "Preferred worker role for dispatch" }),
  ),
  priority: Type.Optional(
    Type.Number({
      description: "Priority (lower = higher priority, default 10)",
    }),
  ),
});

type QueueToolInput = Static<typeof QueueToolParams>;

const SendToolParams = Type.Object({
  to: Type.String({
    description: 'Recipient actor name (e.g., "manager", "parent", or worker name)',
  }),
  type: Type.Union(
    [
      Type.Literal("directive"),
      Type.Literal("status_report"),
      Type.Literal("question"),
      Type.Literal("answer"),
      Type.Literal("work_dispatch"),
      Type.Literal("ack"),
    ],
    { description: "Message type" },
  ),
  payload: Type.Record(Type.String(), Type.Unknown(), {
    description: "Message payload",
  }),
});

type SendToolInput = Static<typeof SendToolParams>;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let loopActive = false;
  let sessions: Map<string, SubmoduleSession> = new Map();
  let managerSpawned = false;
  let managerSpawnedAt: Date | null = null;
  let managerTmuxSession: string | null = null;
  let managerRecoveryAttempts = 0;
  let managerStaleCount = 0;
  let launchStartedAt: Date | null = null;
  const MAX_MANAGER_RECOVERY = 5;
  const mergedWorkers = new Set<string>();

  // Last context reference for notifying on background errors
  let lastCtx: { ui: { notify: Function; setStatus: Function } } | null = null;

  // Track last-surfaced error log content to avoid dedup spam
  let lastSurfacedErrorHash = "";

  // Cache for turn_end reads — mtime-based validation (no TTL)
  let cachedManagerStatus: {
    data: ManagerStatusFile | null;
    mtime: number;
  } | null = null;
  let cachedGoalConfigs: {
    data: SubmoduleConfig[];
    mtimes: Map<string, number>;
  } | null = null;

  async function getFileMtime(path: string): Promise<number> {
    try {
      const st = await stat(path);
      return st.mtimeMs;
    } catch {
      return 0; // file doesn't exist
    }
  }

  function invalidateCache(): void {
    cachedManagerStatus = null;
    cachedGoalConfigs = null;
  }

  // --- tmux helpers ---

  async function tmuxNewSession(name: string, cmd: string, cwdPath: string): Promise<void> {
    await pi.exec("tmux", ["-L", TMUX_SERVER, "new-session", "-d", "-s", name, "-c", cwdPath, "bash", "-c", cmd], { cwd: cwdPath });
  }

  async function tmuxHasSession(name: string): Promise<boolean> {
    try {
      const result = await pi.exec("tmux", ["-L", TMUX_SERVER, "has-session", "-t", name], { cwd });
      return result?.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function tmuxKillSession(name: string): Promise<void> {
    try {
      await pi.exec("tmux", ["-L", TMUX_SERVER, "kill-session", "-t", name], { cwd });
    } catch { /* session may not exist */ }
  }

  async function tmuxCapture(name: string, lines = 200): Promise<string> {
    try {
      const result = await pi.exec("tmux", ["-L", TMUX_SERVER, "capture-pane", "-t", name, "-p", "-S", `-${lines}`], { cwd });
      if (result?.exitCode !== 0) return "";
      return result.stdout ?? "";
    } catch {
      return "";
    }
  }

  async function tmuxListSessions(): Promise<string[]> {
    try {
      const result = await pi.exec("tmux", ["-L", TMUX_SERVER, "list-sessions", "-F", "#{session_name}"], { cwd });
      if (result?.exitCode !== 0) return [];
      return (result.stdout ?? "").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async function tmuxKillServer(): Promise<void> {
    try {
      await pi.exec("tmux", ["-L", TMUX_SERVER, "kill-server"], { cwd });
    } catch { /* server may not exist */ }
  }

  // --- Helpers ---

  /** Normalize tmux capture: strip ANSI codes, spinners, timestamps for stable comparison */
  function normalizeCapture(raw: string): string {
    return raw
      .replace(/\x1b\[[0-9;]*m/g, "")           // ANSI color codes
      .replace(/\x1b\[\d*[A-Ha-h]/g, "")         // ANSI cursor movement
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")           // spinner characters
      .replace(/\d{2}:\d{2}:\d{2}/g, "")          // HH:MM:SS timestamps
      .replace(/\s+/g, " ")                       // normalize whitespace
      .trim();
  }

  /** Check worker activity: active, stalled, or dead */
  async function checkWorkerActivity(session: SubmoduleSession): Promise<"active" | "stalled" | "dead"> {
    if (!session.tmuxSession) return "dead";
    const alive = await tmuxHasSession(session.tmuxSession);
    if (!alive) return "dead";

    // Capture last 5 lines of output for change detection
    const recent = normalizeCapture(await tmuxCapture(session.tmuxSession, 5) ?? "");
    if (recent === session._lastCapture) {
      session._stalledSince ??= Date.now();
      const stalledMs = Date.now() - session._stalledSince;
      return stalledMs > WORKER_STALL_THRESHOLD_MS ? "stalled" : "active";
    }
    session._lastCapture = recent;
    session._stalledSince = null;
    return "active";
  }

  /** Read-only activity check for dashboard (does NOT mutate session state) */
  async function peekWorkerActivity(session: SubmoduleSession): Promise<"active" | "stalled" | "dead"> {
    if (!session.tmuxSession) return "dead";
    const alive = await tmuxHasSession(session.tmuxSession);
    if (!alive) return "dead";
    if (session._stalledSince) {
      return (Date.now() - session._stalledSince) > WORKER_STALL_THRESHOLD_MS ? "stalled" : "active";
    }
    return "active";
  }

  /** Read optional .harness-heartbeat file mtime from worker's worktree */
  async function getWorkerHeartbeat(session: SubmoduleSession): Promise<Date | null> {
    try {
      const st = await stat(join(session.worktreePath, ".harness-heartbeat"));
      return st.mtime;
    } catch {
      return null; // no heartbeat file — use tmux monitoring only
    }
  }

  /** Write worker state sidecar file */
  async function writeWorkerState(name: string, state: WorkerState): Promise<void> {
    try {
      await mkdir(piAgentDir(), { recursive: true });
      await atomicWriteFile(
        join(piAgentDir(), `${name}.state.json`),
        JSON.stringify(state, null, 2) + "\n",
      );
    } catch {
      // Best effort
    }
  }

  /** Read worker state sidecar file */
  async function readWorkerState(name: string): Promise<WorkerState | null> {
    try {
      const content = await readFile(join(piAgentDir(), `${name}.state.json`), "utf-8");
      const parsed = JSON.parse(content);
      if (!Value.Check(WorkerStateSchema, parsed)) return null;
      return parsed as WorkerState;
    } catch {
      return null;
    }
  }

  function piAgentDir(): string {
    return join(cwd, PI_AGENT_DIR);
  }

  function worktreeDir(): string {
    return join(cwd, WORKTREE_DIR);
  }

  function statePath(): string {
    return join(cwd, LAUNCH_STATE_FILE);
  }

  function managerDirPath(): string {
    return join(cwd, MANAGER_DIR);
  }

  async function readGoalFiles(): Promise<SubmoduleConfig[]> {
    const configs: SubmoduleConfig[] = [];
    try {
      const files = await readdir(piAgentDir());
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        if (file.startsWith(".")) continue;
        try {
          const content = await readFile(join(piAgentDir(), file), "utf-8");
          configs.push(parseGoalFile(content, file));
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist
    }
    return configs;
  }

  function countCompleted(config: SubmoduleConfig): number {
    return config.goals.filter((g) => g.completed).length;
  }

  function buildHeartbeatMd(config: SubmoduleConfig): string {
    const lines: string[] = [];
    lines.push(`# ${config.name}`);
    lines.push("");
    lines.push("interval: 5m");
    lines.push("");
    lines.push("## Tasks");
    lines.push("");
    for (const goal of config.goals) {
      if (!goal.completed) {
        lines.push(`- [ ] ${goal.text}`);
      }
    }
    const answeredQuestions = config.questions?.filter((q) => q.answered) ?? [];
    if (answeredQuestions.length > 0) {
      lines.push("");
      lines.push("## Answered Questions");
      for (const q of answeredQuestions) {
        lines.push(`- ! ${q.text} → ${q.answer}`);
      }
    }
    if (config.context) {
      lines.push("");
      lines.push(`## Context`);
      lines.push(config.context);
    }
    lines.push("");
    return lines.join("\n");
  }

  async function persistState(): Promise<void> {
    const state: LaunchState = {
      active: loopActive,
      sessions: {},
      managerSpawned,
      managerCwd: managerDirPath(),
      managerSpawnedAt: managerSpawnedAt?.toISOString() ?? null,
      managerTmuxSession,
    };
    for (const [name, session] of sessions) {
      state.sessions[name] = {
        worktreePath: session.worktreePath,
        branch: session.branch,
        spawned: session.spawned,
        spawnedAt: session.spawnedAt?.toISOString() ?? null,
        tmuxSession: session.tmuxSession,
      };
    }
    try {
      await mkdir(piAgentDir(), { recursive: true });
      await atomicWriteFile(
        statePath(),
        JSON.stringify(state, null, 2) + "\n",
      );
    } catch (e) {
      lastCtx?.ui.notify(
        `Harness state save failed: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }
  }

  async function restoreState(): Promise<void> {
    try {
      const content = await readFile(statePath(), "utf-8");
      const parsed = JSON.parse(content);
      if (!Value.Check(LaunchStateSchema, parsed)) {
        lastCtx?.ui.notify(
          "Harness state file is malformed — starting fresh",
          "warning",
        );
        return;
      }
      const state = parsed as LaunchState;
      loopActive = state.active;
      managerSpawned = state.managerSpawned ?? false;
      managerSpawnedAt = state.managerSpawnedAt
        ? new Date(state.managerSpawnedAt)
        : null;
      managerTmuxSession = state.managerTmuxSession ?? null;
      sessions = new Map();
      for (const [name, s] of Object.entries(state.sessions)) {
        sessions.set(name, {
          name,
          worktreePath: s.worktreePath,
          branch: s.branch,
          spawned: s.spawned,
          spawnedAt: s.spawnedAt ? new Date(s.spawnedAt) : null,
          tmuxSession: s.tmuxSession ?? null,
        });
      }
    } catch {
      // No saved state — first run
    }
  }

  /** Add a filename to the per-worktree git exclude file (never committed). */
  async function addToWorktreeExclude(wtPath: string, filename: string): Promise<void> {
    let excludeDir: string;
    try {
      const gitFileContent = await readFile(join(wtPath, ".git"), "utf-8");
      const gitDirMatch = gitFileContent.match(/^gitdir:\s*(.+)$/m);
      excludeDir = gitDirMatch ? resolve(wtPath, gitDirMatch[1].trim()) : join(wtPath, ".git");
    } catch {
      excludeDir = join(wtPath, ".git");
    }
    const excludeFile = join(excludeDir, "info", "exclude");
    await mkdir(join(excludeDir, "info"), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(excludeFile, "utf-8");
    } catch { /* no exclude file yet */ }
    if (!existing.includes(filename)) {
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      await writeFile(excludeFile, existing + separator + filename + "\n", "utf-8");
    }
  }

  async function createWorktree(
    config: SubmoduleConfig,
  ): Promise<SubmoduleSession> {
    const name = config.name;
    const branch = `pi-agent/${name}`;
    const wtPath = resolve(worktreeDir(), name);

    try {
      await mkdir(worktreeDir(), { recursive: true });
      await pi.exec("git", ["worktree", "add", wtPath, "-b", branch], { cwd });
    } catch {
      // Worktree may already exist — try to reuse
      try {
        await pi.exec("git", ["worktree", "add", wtPath, branch], { cwd });
      } catch {
        // Branch and worktree already exist — verify the path actually exists
        try {
          await stat(wtPath);
        } catch {
          throw new Error(`Failed to create worktree at ${wtPath} for ${name}`);
        }
      }
    }

    // Write heartbeat.md into the worktree (untracked working file for
    // the heartbeat extension — should NOT be committed/merged).
    const heartbeatContent = buildHeartbeatMd(config);
    try {
      await atomicWriteFile(join(wtPath, "heartbeat.md"), heartbeatContent);
      await addToWorktreeExclude(wtPath, "heartbeat.md");
    } catch (e) {
      lastCtx?.ui.notify(
        `Failed to write heartbeat for ${name}: ${e instanceof Error ? e.message : String(e)}`,
        "warning",
      );
    }

    const session: SubmoduleSession = {
      name,
      worktreePath: wtPath,
      branch,
      spawned: false,
      spawnedAt: null,
      tmuxSession: null,
    };
    sessions.set(name, session);
    return session;
  }

  async function spawnSession(
    session: SubmoduleSession,
    config: SubmoduleConfig,
  ): Promise<void> {
    const role = getRole(config.role);

    const goalList = config.goals
      .filter((g) => !g.completed)
      .map((g) => `- ${g.text}`)
      .join("\n");

    // Build answered questions context
    const answeredQuestions = config.questions?.filter((q) => q.answered) ?? [];
    const answeredSection =
      answeredQuestions.length > 0
        ? [
            "",
            "## Answered Questions",
            ...answeredQuestions.map((q) => `- ! ${q.text} → ${q.answer}`),
            "",
          ].join("\n")
        : "";

    // Goal file path for worker to write questions
    const goalFilePath = resolve(cwd, PI_AGENT_DIR, goalFileName(config.name));

    const prompt = [
      `You are ${role.persona}, working on "${config.name}".`,
      "",
      "## Goals",
      goalList,
      "",
      config.context ? `## Context\n${config.context}\n` : "",
      answeredSection,
      "## Instructions",
      ...role.instructions.map((i) => `- ${i}`),
      `- You are working in a git worktree on branch \`${session.branch}\``,
      `- Your focus area is \`${config.path}\`. Start by understanding the code in this directory before making changes elsewhere.`,
      "- If your goals require changes outside your focus area, note it but keep the majority of work within scope.",
      `- When you complete a goal, edit your goal file at \`${goalFilePath}\` to change \`- [ ]\` to \`- [x]\` for that goal`,
      "- After completing each goal, immediately update the goal file so the manager can track your progress",
      "- NEVER modify heartbeat.md or .pi-agent-prompt.md — they are managed by the harness",
      "- Commit your work frequently, but do NOT commit or stage heartbeat.md or .pi-agent-prompt.md",
      "- Do not switch branches",
      "",
      "## Asking Questions",
      `If you need a decision or clarification from the user, write your question to the goal file at \`${goalFilePath}\`.`,
      "Append to the `## Questions` section using the format: `- ? Your question here`",
      "Then periodically re-read the goal file to check for answers (lines starting with `- !`).",
      "",
      "## Mailbox",
      `Your inbox is at \`${resolve(cwd, MAILBOX_DIR, config.name)}/\`.`,
      "Before starting any new goal, check your inbox for messages.",
      "Read all *.json files in your inbox directory, sorted by filename.",
      "Each file is a JSON message with: id, from, to, type, timestamp, payload.",
      "Process each message by type:",
      "- **directive**: Follow the instruction (e.g., new goals, changes in direction)",
      "- **work_dispatch**: Accept the dispatched queue item, add its goals to your work",
      "- **answer**: Use the answer to unblock your work",
      "- **ack**: Note acknowledgment",
      "After processing each message, delete the file.",
      "To send a message to another actor, write a JSON file to `.pi-agent/.mailboxes/{recipient}/` with:",
      '`{ "id": "<timestamp>-<4chars>", "from": "' + config.name + '", "to": "<recipient>",',
      '  "type": "<type>", "timestamp": "<ISO 8601>", "payload": { ... } }`',
    ].join("\n");

    // Write prompt to file to avoid shell escaping issues
    await mkdir(session.worktreePath, { recursive: true });
    const promptFile = join(session.worktreePath, ".pi-agent-prompt.md");
    await atomicWriteFile(promptFile, prompt);
    // Exclude .pi-agent-prompt.md from git so workers doing `git add .`
    // don't commit it — prevents add/add merge conflicts between branches.
    await addToWorktreeExclude(session.worktreePath, ".pi-agent-prompt.md");

    const tmuxName = `worker-${sanitizeTmuxName(config.name)}`;
    const cmd = `pi -p "$(cat .pi-agent-prompt.md)"`;
    await tmuxNewSession(tmuxName, cmd, session.worktreePath);

    session.tmuxSession = tmuxName;
    session.spawned = true;
    session.spawnedAt = new Date();

    // Write initial sidecar state
    await writeWorkerState(config.name, {
      name: config.name,
      status: "active",
      goalsCompleted: config.goals.filter(g => g.completed).length,
      goalsTotal: config.goals.length,
      lastActivity: new Date().toISOString(),
      errors: [],
      mergeStatus: "pending",
      dependsOn: config.dependsOn ?? [],
      dependenciesMet: true,
    });
  }

  async function mergeWorktree(
    session: SubmoduleSession,
    config: SubmoduleConfig,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    // Block merge if unanswered questions exist
    const unanswered =
      config.questions?.filter((q) => !q.answered).length ?? 0;
    if (unanswered > 0) {
      return {
        ok: false,
        message: `Cannot merge ${config.name}: ${unanswered} unanswered question(s). Answer all questions before merging.`,
      };
    }

    // Merge from the parent repo (where the worktree branch was created),
    // not from config.path which may be a submodule with separate refs.
    const mergeCwd = cwd;
    // Check exitCode explicitly — pi.exec may return non-zero without
    // throwing, so try/catch alone is insufficient for conflict detection.
    let mergeResult: { stdout?: string; stderr?: string; exitCode?: number };
    try {
      mergeResult = await pi.exec("git", ["merge", session.branch, "--no-edit"], {
        cwd: mergeCwd,
      });
    } catch (e) {
      // pi.exec threw — treat as merge failure
      mergeResult = { exitCode: 1, stderr: e instanceof Error ? e.message : String(e) };
    }

    if (mergeResult.exitCode === 0) {
      // Update sidecar: merged
      await writeWorkerState(config.name, {
        name: config.name,
        status: "completed",
        goalsCompleted: config.goals.filter(g => g.completed).length,
        goalsTotal: config.goals.length,
        lastActivity: new Date().toISOString(),
        errors: [],
        mergeStatus: "merged",
        dependsOn: config.dependsOn ?? [],
        dependenciesMet: true,
      });
      mergedWorkers.add(config.name);
      // Force-remove worktree — after a successful merge the worktree is
      // no longer needed and may contain excluded files (heartbeat.md,
      // .pi-agent-prompt.md) that block non-force removal.
      await removeWorktree(session, true);
      return { ok: true, message: `Merged ${session.branch} into ${config.path}` };
    }

    // Merge failed — abort to clean up conflict state
    const errorMsg = mergeResult.stderr || `git merge exited with code ${mergeResult.exitCode}`;
    try {
      await pi.exec("git", ["merge", "--abort"], { cwd: mergeCwd });
    } catch {
      // merge --abort may fail if there was no merge in progress
    }

    // Update sidecar: conflict
    await writeWorkerState(config.name, {
      name: config.name,
      status: "error",
      goalsCompleted: config.goals.filter(g => g.completed).length,
      goalsTotal: config.goals.length,
      lastActivity: new Date().toISOString(),
      errors: [errorMsg],
      mergeStatus: "conflict",
      dependsOn: config.dependsOn ?? [],
      dependenciesMet: true,
    });

    // Notify via mailbox so manager knows about the conflict
    await sendMailboxMessage(cwd, "parent", "system", "status_report", {
      event: "merge_conflict",
      submodule: config.name,
      branch: session.branch,
      error: errorMsg,
    });

    return {
      ok: false,
      message: `Merge conflict for ${session.branch} — aborted. Manual resolution needed in ${config.path}`,
    };
  }

  async function removeWorktree(
    session: SubmoduleSession,
    force = false,
  ): Promise<void> {
    // Kill tmux session if it exists
    if (session.tmuxSession) {
      await tmuxKillSession(session.tmuxSession);
      session.tmuxSession = null;
    }
    const args = ["worktree", "remove", session.worktreePath];
    if (force) args.push("--force");
    await pi.exec("git", args, { cwd });
    try {
      await pi.exec("git", ["branch", force ? "-D" : "-d", session.branch], { cwd });
    } catch {
      // Branch may already be deleted or need force — don't block worktree removal
    }
  }

  function getSessionEntries(): Array<{
    name: string;
    branch: string;
    worktreePath: string;
  }> {
    return Array.from(sessions.values()).map((s) => ({
      name: s.name,
      branch: s.branch,
      worktreePath: s.worktreePath,
    }));
  }

  async function spawnManager(configs: SubmoduleConfig[], bmadMode?: BmadModeConfig): Promise<void> {
    const mgrDir = managerDirPath();
    await mkdir(mgrDir, { recursive: true });

    // Write static instructions once at launch
    const instructionsFile = join(piAgentDir(), ".manager-instructions.md");
    const instructions = buildManagerInstructions(configs, cwd, bmadMode);
    await atomicWriteFile(instructionsFile, instructions);

    // Write dynamic prompt to file (references instructions)
    const prompt = buildManagerPrompt(configs, getSessionEntries(), cwd);
    const promptFile = join(mgrDir, ".pi-agent-prompt.md");
    await atomicWriteFile(promptFile, prompt);

    const tmuxName = "harness-manager";
    const stopSignalPathEsc = shellEscape(join(cwd, STOP_SIGNAL_FILE));
    const statusFilePathEsc = shellEscape(join(cwd, MANAGER_STATUS_FILE));
    const errorLogPathEsc = shellEscape(join(mgrDir, ".pi-agent-errors.log"));
    // Exit-code-aware loop: track consecutive failures, log errors, bail after MAX_CONSECUTIVE_FAILURES
    const loopCmd = [
      "consecutive_failures=0;",
      "while true; do",
      `if [ -f ${stopSignalPathEsc} ]; then echo "Stop signal detected"; exit 0; fi;`,
      'pi -p "$(cat .pi-agent-prompt.md)";',
      "exit_code=$?;",
      "if [ $exit_code -ne 0 ]; then",
      "consecutive_failures=$((consecutive_failures + 1));",
      `echo "[$(date -u +%FT%TZ)] pi exited with code $exit_code (failure $consecutive_failures/${MAX_CONSECUTIVE_FAILURES})" >> ${errorLogPathEsc};`,
      `if [ $consecutive_failures -ge ${MAX_CONSECUTIVE_FAILURES} ]; then`,
      `echo '{"status":"error","message":"Manager crashed ${MAX_CONSECUTIVE_FAILURES} times consecutively","updatedAt":"'$(date -u +%FT%TZ)'","submodules":{},"stallCount":0}' > ${statusFilePathEsc};`,
      "exit 1;",
      "fi;",
      "sleep 30;",
      "else",
      "consecutive_failures=0;",
      "sleep 120;",
      "fi;",
      "done",
    ].join(" ");
    await tmuxNewSession(tmuxName, loopCmd, mgrDir);

    managerTmuxSession = tmuxName;
    managerSpawned = true;
    managerSpawnedAt = new Date();
  }

  async function writeRunSummary(
    reason: RunSummary["stopReason"],
  ): Promise<RunSummary> {
    const now = new Date();
    const start = launchStartedAt ?? now;
    const durationMs = now.getTime() - start.getTime();
    const durationMin = Math.round(durationMs / 60000);
    const duration = durationMin < 1 ? "<1m" : `${durationMin}m`;

    const configs = await readGoalFiles();
    const workers: RunSummary["workers"] = {};

    // Detect default branch (main, master, etc.)
    let baseBranch = "main";
    try {
      const ref = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], { cwd });
      const parsed = (ref.stdout ?? "").trim().replace(/^origin\//, "");
      if (parsed) baseBranch = parsed;
    } catch { /* fallback to main */ }

    for (const config of configs) {
      const session = sessions.get(config.name);
      let commits = 0;
      let filesChanged = 0;

      if (session) {
        try {
          const logResult = await pi.exec(
            "git",
            ["log", "--oneline", `${baseBranch}..${session.branch}`],
            { cwd },
          );
          commits = logResult.stdout
            ? logResult.stdout.trim().split("\n").filter((l: string) => l.length > 0).length
            : 0;
        } catch {
          // Branch may not exist
        }
        try {
          const diffResult = await pi.exec(
            "git",
            ["diff", "--stat", `${baseBranch}..${session.branch}`],
            { cwd },
          );
          if (diffResult.stdout) {
            const lines = diffResult.stdout.trim().split("\n");
            // Last line is summary; count non-summary lines
            filesChanged = Math.max(0, lines.length - 1);
          }
        } catch {
          // Branch may not exist
        }
      }

      workers[config.name] = {
        role: config.role,
        commits,
        goalsTotal: config.goals.length,
        goalsCompleted: config.goals.filter((g) => g.completed).length,
        filesChanged,
        branch: session?.branch ?? `pi-agent/${config.name}`,
        merged: mergedWorkers.has(config.name),
      };
    }

    // Count unprocessed mailbox messages
    let mailboxUnprocessed = 0;
    try {
      const parentMsgs = await readMailbox(cwd, "parent");
      const managerMsgs = await readMailbox(cwd, "manager");
      mailboxUnprocessed = parentMsgs.length + managerMsgs.length;
    } catch {
      // ignore
    }

    // Count pending queue items
    let queueItemsPending = 0;
    try {
      const queue = await readQueue(cwd);
      queueItemsPending = queue.items.filter((i) => i.status === "pending").length;
    } catch {
      // ignore
    }

    const summary: RunSummary = {
      startedAt: start.toISOString(),
      stoppedAt: now.toISOString(),
      duration,
      stopReason: reason,
      workers,
      mailboxUnprocessed,
      queueItemsPending,
    };

    try {
      await mkdir(piAgentDir(), { recursive: true });
      await atomicWriteFile(
        join(cwd, SUMMARY_FILE),
        JSON.stringify(summary, null, 2) + "\n",
      );
    } catch {
      // Best effort
    }

    // Build human-readable summary message
    const totalGoals = Object.values(workers).reduce((s, w) => s + w.goalsTotal, 0);
    const totalDone = Object.values(workers).reduce((s, w) => s + w.goalsCompleted, 0);
    const totalCommits = Object.values(workers).reduce((s, w) => s + w.commits, 0);
    const workerLines = Object.entries(workers).map(
      ([name, w]) =>
        `- **${name}** [${w.role}]: ${w.goalsCompleted}/${w.goalsTotal} goals, ${w.commits} commits, ${w.filesChanged} files${w.merged ? " (merged)" : ""}`,
    );

    pi.sendMessage(
      {
        customType: "harness-summary",
        content: [
          "## Harness Run Summary",
          "",
          `**Duration:** ${duration} | **Reason:** ${reason}`,
          `**Goals:** ${totalDone}/${totalGoals} | **Commits:** ${totalCommits}`,
          "",
          "### Workers",
          ...workerLines,
          "",
          mailboxUnprocessed > 0
            ? `**Unprocessed messages:** ${mailboxUnprocessed}`
            : "",
          queueItemsPending > 0
            ? `**Pending queue items:** ${queueItemsPending}`
            : "",
        ]
          .filter((l) => l.length > 0)
          .join("\n"),
        display: true,
      },
      { triggerTurn: false },
    );

    return summary;
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    lastCtx = ctx;
    await restoreState();

    // Verify tmux sessions still exist after restore
    if (managerTmuxSession) {
      const alive = await tmuxHasSession(managerTmuxSession);
      if (!alive) managerTmuxSession = null;
    }
    for (const [, session] of sessions) {
      if (session.tmuxSession) {
        const alive = await tmuxHasSession(session.tmuxSession);
        if (!alive) session.tmuxSession = null;
      }
    }

    // Ensure mailbox directories exist
    try {
      await mkdir(mailboxPath(cwd, "parent"), { recursive: true });
      await mkdir(mailboxPath(cwd, "manager"), { recursive: true });
    } catch {
      // Best effort
    }

    if (loopActive) {
      const status = await readManagerStatus(cwd);
      if (status) {
        const totalGoals = Object.values(status.submodules).reduce(
          (sum, s) => sum + s.total,
          0,
        );
        const doneGoals = Object.values(status.submodules).reduce(
          (sum, s) => sum + s.completed,
          0,
        );
        ctx.ui.setStatus(
          "harness",
          `harness: ${doneGoals}/${totalGoals} goals, ${status.status}`,
        );
      } else {
        ctx.ui.setStatus("harness", "harness: active");
      }

      const configs = await readGoalFiles();
      if (configs.length > 0) {
        // Check actual liveness — managerSpawned only means "was spawned before"
        const managerAlive = managerTmuxSession ? await tmuxHasSession(managerTmuxSession) : false;
        pi.sendMessage(
          {
            customType: "harness-restored",
            content: `Submodule harness restored with ${configs.length} submodule(s). Manager ${managerAlive ? "is running" : "needs recovery"}.`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!loopActive) return;
    lastCtx = ctx;

    // Check context usage
    try {
      const usage = ctx.getContextUsage();
      if (usage && usage.percent >= CONTEXT_CRITICAL_PERCENT) {
        loopActive = false;
        await persistState();
        ctx.ui.setStatus("harness", "harness: context-full");
        ctx.ui.notify("Harness deactivated — context window nearly full", "warning");
        return;
      }
    } catch {
      // getContextUsage may not be available
    }

    // Primary manager liveness: is the tmux session alive?
    if (managerTmuxSession) {
      const alive = await tmuxHasSession(managerTmuxSession);
      if (!alive) {
        managerTmuxSession = null;
        // tmux session is dead — treat as stale for recovery
        // managerSpawned stays true so recovery logic knows to attempt respawn
      }
    }

    // Read manager status (with mtime-based cache)
    const now = Date.now();
    let status: ManagerStatusFile | null;
    const statusMtime = await getFileMtime(join(cwd, MANAGER_STATUS_FILE));
    if (cachedManagerStatus && cachedManagerStatus.mtime === statusMtime && statusMtime > 0) {
      status = cachedManagerStatus.data;
    } else {
      status = await readManagerStatus(cwd);
      cachedManagerStatus = { data: status, mtime: statusMtime };
    }

    // Shared auto-recovery logic for dead/stale manager
    async function attemptAutoRecovery(reason: string): Promise<"recovered" | "exhausted" | "waiting"> {
      managerStaleCount++;
      const requiredStaleCount = RECOVERY_BACKOFF[Math.min(managerRecoveryAttempts, RECOVERY_BACKOFF.length - 1)];
      if (managerStaleCount >= requiredStaleCount && managerRecoveryAttempts < MAX_MANAGER_RECOVERY) {
        managerRecoveryAttempts++;
        managerStaleCount = 0;
        pi.sendMessage(
          {
            customType: "harness-auto-recover",
            content: `${reason} — auto-recovering (attempt ${managerRecoveryAttempts}/${MAX_MANAGER_RECOVERY})`,
            display: true,
          },
          { triggerTurn: false },
        );
        if (managerTmuxSession) {
          await tmuxKillSession(managerTmuxSession);
          managerTmuxSession = null;
        }
        // Preserve error log before deleting manager dir
        try {
          const errorLogPath = join(managerDirPath(), ".pi-agent-errors.log");
          const prevPath = join(cwd, ".pi-agent-errors.log.prev");
          await copyFile(errorLogPath, prevPath);
        } catch { /* no error log to preserve */ }
        try {
          await rm(managerDirPath(), { recursive: true, force: true });
        } catch { /* may not exist */ }
        try {
          await rm(join(cwd, STOP_SIGNAL_FILE));
        } catch { /* may not exist */ }
        const configs = await readGoalFiles();
        if (configs.length > 0) {
          await spawnManager(configs);
          await persistState();
        }
        return "recovered";
      } else if (managerRecoveryAttempts >= MAX_MANAGER_RECOVERY) {
        pi.sendMessage(
          {
            customType: "harness-recovery-failed",
            content: `## Manager Recovery Failed\n\nAll ${MAX_MANAGER_RECOVERY} recovery attempts exhausted.\n\nRun \`/harness:recover --force\` to reset the counter and try again.\nRun \`/harness:logs manager\` to see recent output.\nRun \`/harness:stop\` to shut down.`,
            display: true,
          },
          { triggerTurn: false },
        );
        return "exhausted";
      }
      return "waiting";
    }

    if (!status) {
      if (managerSpawned) {
        const result = await attemptAutoRecovery("Manager appears dead");
        if (result === "recovered") {
          ctx.ui.setStatus("harness", "harness: manager recovering");
        } else if (result === "exhausted") {
          ctx.ui.setStatus("harness", "harness: manager failed — run /harness:recover --force");
        } else {
          ctx.ui.setStatus("harness", "harness: manager stale");
        }
      }
      return;
    }

    // Check liveness
    const age = now - new Date(status.updatedAt).getTime();
    if (age > MANAGER_STALE_THRESHOLD_MS) {
      const result = await attemptAutoRecovery(`Manager stale for ${Math.round(age / 60000)}m`);
      if (result === "recovered") {
        ctx.ui.setStatus("harness", "harness: manager recovering");
      } else if (result === "exhausted") {
        ctx.ui.setStatus("harness", "harness: manager failed — run /harness:recover --force");
      } else {
        ctx.ui.setStatus("harness", "harness: manager stale");
      }
      return;
    }

    // Manager is alive — reset stale tracking
    managerStaleCount = 0;

    // Update status bar
    const totalGoals = Object.values(status.submodules).reduce(
      (sum, s) => sum + s.total,
      0,
    );
    const doneGoals = Object.values(status.submodules).reduce(
      (sum, s) => sum + s.completed,
      0,
    );

    // Check for unanswered questions (with mtime-based cache)
    let questionSuffix = "";
    try {
      let configs: SubmoduleConfig[];
      let goalCacheValid = false;
      if (cachedGoalConfigs) {
        goalCacheValid = true;
        try {
          const files = await readdir(piAgentDir());
          const mdFiles = files.filter(f => f.endsWith(".md") && !f.startsWith("."));
          if (mdFiles.length !== cachedGoalConfigs.mtimes.size) {
            goalCacheValid = false;
          } else {
            for (const file of mdFiles) {
              const mtime = await getFileMtime(join(piAgentDir(), file));
              if (cachedGoalConfigs.mtimes.get(file) !== mtime) {
                goalCacheValid = false;
                break;
              }
            }
          }
        } catch {
          goalCacheValid = false;
        }
      }
      if (goalCacheValid && cachedGoalConfigs) {
        configs = cachedGoalConfigs.data;
      } else {
        configs = await readGoalFiles();
        const mtimes = new Map<string, number>();
        try {
          const files = await readdir(piAgentDir());
          for (const file of files.filter(f => f.endsWith(".md") && !f.startsWith("."))) {
            mtimes.set(file, await getFileMtime(join(piAgentDir(), file)));
          }
        } catch { /* ignore */ }
        cachedGoalConfigs = { data: configs, mtimes };
      }
      const unanswered = configs.reduce(
        (sum, c) => sum + (c.questions?.filter((q) => !q.answered).length ?? 0),
        0,
      );
      if (unanswered > 0) {
        questionSuffix = `, ${unanswered}?`;
      }
    } catch {
      // ignore
    }

    // Check parent inbox for messages
    let inboxSuffix = "";
    try {
      const inboxMessages = await readMailbox(cwd, "parent");
      if (inboxMessages.length > 0) {
        inboxSuffix = `, ${inboxMessages.length} msg`;
        // Surface and delete all inbox messages
        for (const { message, filename } of inboxMessages) {
          if (message.type === "question") {
            pi.sendMessage(
              {
                customType: "harness-question",
                content: `**Question from ${message.from}:** ${message.payload.question ?? JSON.stringify(message.payload)}`,
                display: true,
              },
              { triggerTurn: false },
            );
          } else {
            pi.sendMessage(
              {
                customType: "harness-inbox",
                content: `**[${message.type}] from ${message.from}:** ${JSON.stringify(message.payload)}`,
                display: true,
              },
              { triggerTurn: false },
            );
          }
          await deleteMessage(cwd, "parent", filename);
        }
      }
    } catch {
      // ignore
    }

    // Surface manager error log if present (deduplicated — only send when content changes)
    try {
      const errorLogPath = join(cwd, MANAGER_DIR, ".pi-agent-errors.log");
      const errorLog = await readFile(errorLogPath, "utf-8");
      const errorLines = errorLog.trim().split("\n").filter(Boolean);
      if (errorLines.length > 0) {
        // Rotate: keep last 100 lines
        if (errorLines.length > 100) {
          await atomicWriteFile(errorLogPath, errorLines.slice(-100).join("\n") + "\n");
        }
        const lastErrors = errorLines.slice(-5).join("\n");
        // Only surface if content changed since last notification
        if (lastErrors !== lastSurfacedErrorHash) {
          lastSurfacedErrorHash = lastErrors;
          pi.sendMessage(
            {
              customType: "harness-manager-errors",
              content: `**Manager errors detected:**\n\`\`\`\n${lastErrors}\n\`\`\``,
              display: true,
            },
            { triggerTurn: false },
          );
        }
      }
    } catch {
      // No error log — good
    }

    // Check worker activity (heartbeat monitoring) and update sidecar state
    let activeWorkerCount = 0;
    let stalledWorkerCount = 0;
    let deadWorkerCount = 0;
    for (const [name, session] of sessions) {
      if (session.tmuxSession) {
        const activity = await checkWorkerActivity(session);
        if (activity === "dead") {
          session.spawned = false;
          session.tmuxSession = null;
          deadWorkerCount++;
        } else if (activity === "stalled") {
          stalledWorkerCount++;
        } else {
          activeWorkerCount++;
        }
        // Update sidecar state based on activity
        const existing = await readWorkerState(name);
        if (existing && existing.status !== "completed") {
          existing.status = activity === "dead" ? "error" : activity;
          existing.lastActivity = new Date().toISOString();
          await writeWorkerState(name, existing);
        }
      } else if (session.spawned) {
        deadWorkerCount++;
      }
    }
    const workerSuffix = sessions.size > 0
      ? `, ${activeWorkerCount}a/${stalledWorkerCount}s/${deadWorkerCount}d`
      : "";

    ctx.ui.setStatus(
      "harness",
      `harness: ${doneGoals}/${totalGoals} goals, ${status.status}${workerSuffix}${questionSuffix}${inboxSuffix}`,
    );

    // Check terminal states
    if (
      status.status === "all_complete" ||
      status.status === "stopped" ||
      status.status === "stalled"
    ) {
      const reason =
        status.status === "all_complete"
          ? "all_complete"
          : status.status === "stalled"
            ? "stalled"
            : "user_stop";
      await writeRunSummary(reason);
      loopActive = false;
      await persistState();
      const terminalLabel = status.status === "all_complete" ? "done" : status.status;
      ctx.ui.setStatus(
        "harness",
        `harness: ${doneGoals}/${totalGoals} goals, ${terminalLabel}`,
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await persistState();
  });

  // --- Tools ---

  pi.registerTool({
    name: "harness_status",
    label: "Harness Status",
    description:
      "Check progress across all submodule launch sessions. " +
      "Returns per-submodule goal completion status.",
    parameters: Type.Object({}),

    async execute() {
      const configs = await readGoalFiles();
      if (configs.length === 0) {
        return {
          content: [
            { type: "text", text: "No goal files found in .pi-agent/" },
          ],
          details: {},
        };
      }

      const summary = buildProgressSummary(configs);
      const totalGoals = configs.reduce((sum, c) => sum + c.goals.length, 0);
      const totalDone = configs.reduce((sum, c) => sum + countCompleted(c), 0);
      const totalQuestions = configs.reduce(
        (sum, c) => sum + (c.questions?.length ?? 0),
        0,
      );
      const unansweredQuestions = configs.reduce(
        (sum, c) => sum + (c.questions?.filter((q) => !q.answered).length ?? 0),
        0,
      );

      return {
        content: [{ type: "text", text: summary }],
        details: {
          submodules: configs.length,
          totalGoals,
          completedGoals: totalDone,
          totalQuestions,
          unansweredQuestions,
          loopActive,
        },
      };
    },
  });

  pi.registerTool({
    name: "harness_update_goal",
    label: "Update Harness Goal",
    description:
      "Add, complete, or remove a goal for a submodule. " +
      "Updates the .pi-agent/<submodule>.md goal file.",
    parameters: UpdateGoalParams,

    async execute(_toolCallId, params: UpdateGoalInput) {
      const configs = await readGoalFiles();
      const config = configs.find(
        (c) => c.name.toLowerCase() === params.submodule.toLowerCase(),
      );

      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `Submodule "${params.submodule}" not found. Available: ${configs.map((c) => c.name).join(", ") || "none"}`,
            },
          ],
          details: {},
        };
      }

      switch (params.action) {
        case "add":
          config.goals.push({ text: params.goal, completed: false });
          break;
        case "complete": {
          const result = fuzzyMatchOne(
            config.goals,
            (g) => g.text,
            params.goal,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: `No matching goal found for "${params.goal}" in ${config.name}`,
                },
              ],
              details: {},
            };
          }
          if ("ambiguous" in result) {
            return {
              content: [
                {
                  type: "text",
                  text: `Ambiguous match for "${params.goal}" in ${config.name}. Matches: ${result.ambiguous.map((g) => g.text).join("; ")}`,
                },
              ],
              details: {},
            };
          }
          result.match.completed = true;
          break;
        }
        case "remove": {
          const result = fuzzyMatchOne(
            config.goals,
            (g) => g.text,
            params.goal,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: `No matching goal found for "${params.goal}" in ${config.name}`,
                },
              ],
              details: {},
            };
          }
          if ("ambiguous" in result) {
            return {
              content: [
                {
                  type: "text",
                  text: `Ambiguous match for "${params.goal}" in ${config.name}. Matches: ${result.ambiguous.map((g) => g.text).join("; ")}`,
                },
              ],
              details: {},
            };
          }
          const idx = config.goals.indexOf(result.match);
          config.goals.splice(idx, 1);
          break;
        }
      }

      // Write back
      invalidateCache();
      const serialized = serializeGoalFile(config);
      const filename = goalFileName(config.name);
      try {
        await atomicWriteFile(join(piAgentDir(), filename), serialized);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      const done = config.goals.filter((g) => g.completed).length;
      return {
        content: [
          {
            type: "text",
            text: `Updated ${config.name}: ${params.action} "${params.goal}" (${done}/${config.goals.length} complete)`,
          },
        ],
        details: { goals: config.goals },
      };
    },
  });

  pi.registerTool({
    name: "harness_add_task",
    label: "Add Harness Task",
    description:
      "Create a standalone worktree task. Writes a .pi-agent/<name>.md " +
      "goal file that can be launched with /harness:launch.",
    parameters: AddTaskParams,

    async execute(_toolCallId, params: AddTaskInput) {
      const name = params.name.trim();
      if (!name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid task name "${name}". Use kebab-case (e.g., "refactor-auth").`,
            },
          ],
          details: {},
        };
      }

      const goalFile = join(piAgentDir(), goalFileName(name));
      try {
        await readFile(goalFile, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `Task "${name}" already exists at .pi-agent/${goalFileName(name)}. Use harness_update_goal to modify it.`,
            },
          ],
          details: {},
        };
      } catch {
        // File doesn't exist — proceed
      }

      const roleName = params.role?.trim().toLowerCase() ?? "developer";
      const validRole = HARNESS_ROLES.some((r) => r.name === roleName)
        ? roleName
        : "developer";

      const config: SubmoduleConfig = {
        name,
        path: params.path ?? ".",
        role: validRole,
        goals: params.goals.map((g) => ({ text: g, completed: false })),
        questions: [],
        context: params.context ?? "",
        rawContent: "",
      };

      const content = serializeGoalFile(config);
      try {
        await mkdir(piAgentDir(), { recursive: true });
        await atomicWriteFile(goalFile, content);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
      invalidateCache();

      return {
        content: [
          {
            type: "text",
            text: `Created task "${name}" with ${config.goals.length} goal(s) at .pi-agent/${name}.md`,
          },
        ],
        details: { name, goals: config.goals, path: config.path },
      };
    },
  });

  pi.registerTool({
    name: "harness_ask",
    label: "Ask Harness Question",
    description:
      "Stage a question in a submodule's goal file for the user to answer. " +
      "Workers waiting on answers are not considered stalled.",
    parameters: AskParams,

    async execute(_toolCallId, params: AskInput) {
      const configs = await readGoalFiles();
      const config = configs.find(
        (c) => c.name.toLowerCase() === params.submodule.toLowerCase(),
      );

      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `Submodule "${params.submodule}" not found. Available: ${configs.map((c) => c.name).join(", ") || "none"}`,
            },
          ],
          details: {},
        };
      }

      config.questions.push({
        text: params.question,
        answered: false,
      });

      invalidateCache();
      const serialized = serializeGoalFile(config);
      const filename = goalFileName(config.name);
      try {
        await atomicWriteFile(join(piAgentDir(), filename), serialized);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      const unanswered = config.questions.filter((q) => !q.answered).length;
      return {
        content: [
          {
            type: "text",
            text: `Question staged for ${config.name}: "${params.question}" (${unanswered} unanswered)`,
          },
        ],
        details: { unanswered },
      };
    },
  });

  pi.registerTool({
    name: "harness_answer",
    label: "Answer Harness Question",
    description:
      "Answer a staged question in a submodule's goal file. " +
      "Fuzzy-matches the question text against unanswered questions.",
    parameters: AnswerParams,

    async execute(_toolCallId, params: AnswerInput) {
      const configs = await readGoalFiles();
      const config = configs.find(
        (c) => c.name.toLowerCase() === params.submodule.toLowerCase(),
      );

      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `Submodule "${params.submodule}" not found. Available: ${configs.map((c) => c.name).join(", ") || "none"}`,
            },
          ],
          details: {},
        };
      }

      // Tiered fuzzy match against unanswered questions
      const unansweredQs = config.questions.filter((q) => !q.answered);
      const result = fuzzyMatchOne(
        unansweredQs,
        (q) => q.text,
        params.question,
      );

      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: `No matching unanswered question for "${params.question}" in ${config.name}. Unanswered: ${unansweredQs.map((q) => q.text).join("; ") || "none"}`,
            },
          ],
          details: {},
        };
      }
      if ("ambiguous" in result) {
        return {
          content: [
            {
              type: "text",
              text: `Ambiguous match for "${params.question}" in ${config.name}. Matches: ${result.ambiguous.map((q) => q.text).join("; ")}`,
            },
          ],
          details: {},
        };
      }

      result.match.answered = true;
      result.match.answer = params.answer;

      invalidateCache();
      const serialized = serializeGoalFile(config);
      const filename = goalFileName(config.name);
      try {
        await atomicWriteFile(join(piAgentDir(), filename), serialized);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }

      const remaining = config.questions.filter((q) => !q.answered).length;
      return {
        content: [
          {
            type: "text",
            text: `Answered "${result.match.text}" → "${params.answer}" for ${config.name} (${remaining} unanswered remaining)`,
          },
        ],
        details: { remaining },
      };
    },
  });

  pi.registerTool({
    name: "harness_queue",
    label: "Queue Harness Work",
    description:
      "Add work to the harness queue. The manager dispatches queued items " +
      "to workers based on role and capacity.",
    parameters: QueueToolParams,

    async execute(_toolCallId, params: QueueToolInput) {
      if (!loopActive) {
        return {
          content: [{ type: "text" as const, text: "Harness is not active. Start with /harness:launch first." }],
          isError: true,
        };
      }
      const id = generateMessageId();
      const queueLength = await withQueueLock(cwd, async () => {
        const queue = await readQueue(cwd);
        const item: QueueItem = {
          id,
          topic: params.topic,
          description: params.description ?? params.topic,
          goals: params.goals,
          role: params.role,
          priority: params.priority ?? 10,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        queue.items.push(item);
        await writeQueue(cwd, queue);
        return queue.items.length;
      });
      invalidateCache();

      // Notify manager of new work
      await sendMailboxMessage(cwd, "manager", "parent", "directive", {
        text: `New queue item: ${params.topic}`,
        queueItemId: id,
      });

      return {
        content: [
          {
            type: "text",
            text: `Queued "${params.topic}" (id: ${id}, ${queueLength} item(s) in queue)`,
          },
        ],
        details: { id, queueLength },
      };
    },
  });

  pi.registerTool({
    name: "harness_send",
    label: "Send Harness Message",
    description:
      "Send a message to an actor's mailbox (parent, manager, or worker name).",
    parameters: SendToolParams,

    async execute(_toolCallId, params: SendToolInput) {
      const id = await sendMailboxMessage(
        cwd,
        params.to,
        "parent",
        params.type,
        params.payload as Record<string, unknown>,
      );

      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${params.to} (id: ${id}, type: ${params.type})`,
          },
        ],
        details: { id, to: params.to, type: params.type },
      };
    },
  });

  pi.registerTool({
    name: "harness_inbox",
    label: "Read Harness Inbox",
    description:
      "Read all messages in the parent's mailbox. Messages are deleted after reading.",
    parameters: Type.Object({}),

    async execute() {
      const messages = await readMailbox(cwd, "parent");

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: "No messages in parent inbox." }],
          details: { count: 0 },
        };
      }

      const lines: string[] = [`## Parent Inbox (${messages.length} message(s))`, ""];
      for (const { message, filename } of messages) {
        lines.push(
          `**[${message.type}]** from ${message.from} at ${message.timestamp}`,
        );
        lines.push(`Payload: ${JSON.stringify(message.payload)}`);
        lines.push("");
        // Delete after reading
        await deleteMessage(cwd, "parent", filename);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: messages.length,
          messages: messages.map((m) => m.message),
        },
      };
    },
  });

  // --- BMAD Worker Prompt Builder ---

  function buildBmadWorkerPrompt(
    spec: BmadGoalSpec,
    config: BmadConfig,
    status: WorkflowEntry[],
  ): string {
    const workflowPrompt = WORKFLOW_PROMPTS[spec.workflowName];
    // Get the raw BMAD prompt and adapt it for autonomous execution
    let rawPrompt = workflowPrompt
      ? workflowPrompt(config, status)
      : `## BMAD: ${spec.workflowName}\n\nComplete the ${spec.workflowName} workflow.`;

    // M5: Replace interactive phrases with autonomous equivalents —
    // the raw BMAD prompts are designed for interactive use but BMAD
    // workers run without a user present.
    rawPrompt = rawPrompt
      .replace(/[Ii]nterview the user/g, "Based on existing project documents, fill in")
      .replace(/[Aa]sk the user (?:about |for |to )?/g, "Infer from available documentation ")
      .replace(/[Cc]onfirm with the user/g, "Verify against existing documents")
      .replace(/[Dd]iscuss with the user/g, "Analyze based on available context")
      .replace(/[Pp]resent (?:.*?) to the user/g, "Document in the output file")
      .replace(
        /[Ss]uggest the next recommended workflow to the user/g,
        "Mark your goal as complete — the harness manager handles workflow sequencing",
      );

    const goalFilePath = resolve(cwd, PI_AGENT_DIR, `${BMAD_PREFIX}${spec.workflowName}.md`);
    const workerName = `${BMAD_PREFIX}${spec.workflowName}`;
    const inboxPath = resolve(cwd, MAILBOX_DIR, workerName);
    const role = getRole(spec.role);

    return [
      "## Autonomous BMAD Worker",
      "",
      `You are ${role.persona}, running autonomously in a harness worker. There is no interactive user.`,
      "Make reasonable decisions based on existing project documents.",
      "Do NOT ask questions — use your best judgment based on available context.",
      "Read all prior BMAD documents from the output folder before starting.",
      "",
      "---",
      "",
      rawPrompt,
      "",
      "---",
      "",
      "## Harness Worker Instructions",
      `- When you complete a goal, edit your goal file at \`${goalFilePath}\` to change \`- [ ]\` to \`- [x]\``,
      "- After completing each goal, immediately update the goal file so the manager can track progress",
      "- NEVER modify heartbeat.md or .pi-agent-prompt.md — they are managed by the harness",
      "- Commit your work frequently, but do NOT commit or stage heartbeat.md or .pi-agent-prompt.md",
      "- Do not switch branches",
      "",
      "## Asking Questions",
      "You are running autonomously, so prefer making reasonable decisions over asking questions.",
      "However, if you are truly blocked and cannot proceed without clarification:",
      `1. Write your question to the goal file at \`${goalFilePath}\``,
      "2. Append to the `## Questions` section using the format: `- ? Your question here`",
      "3. Continue working on other goals while waiting",
      "4. Periodically re-read the goal file to check for answers (lines starting with `- !`)",
      "",
      "## When Complete",
      `1. Save the document using \`bmad_save_document\` with workflow \`${spec.workflowName}\``,
      `2. Update status using \`bmad_update_status\` with workflow \`${spec.workflowName}\` and the saved file path`,
      "3. Mark your goal as complete — the harness manager handles workflow sequencing",
      "",
      "## Mailbox",
      `Your inbox is at \`${inboxPath}/\`.`,
      "Before starting any new goal, check your inbox for messages.",
      "Read all *.json files in your inbox directory, sorted by filename.",
      "Each file is a JSON message with: id, from, to, type, timestamp, payload.",
      "Process each message by type:",
      "- **directive**: Follow the instruction (e.g., new goals, changes in direction)",
      "- **work_dispatch**: Accept the dispatched queue item, add its goals to your work",
      "- **answer**: Use the answer to unblock your work",
      "- **ack**: Note acknowledgment",
      "After processing each message, delete the file.",
      `To send a message to another actor, write a JSON file to \`${resolve(cwd, MAILBOX_DIR)}/{recipient}/\` with:`,
      `\`{ "id": "<timestamp>-<4chars>", "from": "${workerName}", "to": "<recipient>",`,
      '  "type": "<type>", "timestamp": "<ISO 8601>", "payload": { ... } }`',
    ].join("\n");
  }

  // --- Commands ---

  pi.registerCommand("harness:launch", {
    description:
      "Read .pi-agent/*.md goals, create worktrees, spawn workers + manager. Supports --max-workers N --stagger <ms>.",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      if (loopActive) {
        const configs = await readGoalFiles();
        const summary = buildProgressSummary(configs);
        pi.sendMessage(
          {
            customType: "harness-already-active",
            content: `Harness is already active.\n\n${summary}`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      // Parse --max-workers and --stagger flags
      let maxWorkers = Infinity;
      let staggerMs = 5000;
      const remaining = (args ?? "").trim();
      const maxFlag = remaining.match(/--max-workers\s+(\d+)/);
      if (maxFlag) {
        maxWorkers = parseInt(maxFlag[1], 10);
      }
      const staggerFlag = remaining.match(/--stagger\s+(\d+)/);
      if (staggerFlag) {
        staggerMs = parseInt(staggerFlag[1], 10);
      }

      const configs = await readGoalFiles();
      if (configs.length === 0) {
        ctx.ui.notify(
          "No goal files found in .pi-agent/. Use /harness:init to scaffold.",
          "warning",
        );
        return;
      }

      // Clean up leftover stop signal from previous runs
      try {
        await rm(join(cwd, STOP_SIGNAL_FILE));
      } catch {
        // No stop signal to clean up
      }

      // Separate configs into launchable (incomplete goals) and skipped (all done)
      const launchable: SubmoduleConfig[] = [];
      const skipped: string[] = [];
      for (const config of configs) {
        const incompleteGoals = config.goals.filter((g) => !g.completed);
        if (incompleteGoals.length === 0) {
          skipped.push(config.name);
        } else {
          launchable.push(config);
        }
      }

      if (launchable.length === 0) {
        ctx.ui.notify("All goals are already complete!", "info");
        return;
      }

      // Sort by incomplete goals descending, then alphabetical
      launchable.sort((a, b) => {
        const aInc = a.goals.filter((g) => !g.completed).length;
        const bInc = b.goals.filter((g) => !g.completed).length;
        if (bInc !== aInc) return bInc - aInc;
        return a.name.localeCompare(b.name);
      });

      // Check dependencies: separate ready vs waiting
      const ready: SubmoduleConfig[] = [];
      const waiting: SubmoduleConfig[] = [];
      for (const config of launchable) {
        if (!config.dependsOn?.length) {
          ready.push(config);
          continue;
        }
        // Warn about unknown dependencies
        const unknownDeps = config.dependsOn.filter(dep => !configs.find(c => c.name === dep));
        if (unknownDeps.length > 0) {
          ctx.ui.notify(`Warning: "${config.name}" has unknown dependencies: ${unknownDeps.join(", ")}`, "warning");
        }
        const unmetDeps = config.dependsOn.filter(dep => {
          const depConfig = configs.find(c => c.name === dep);
          if (!depConfig) return true; // Unknown dependency = unmet (safe default)
          return !depConfig.goals.every(g => g.completed);
        });
        if (unmetDeps.length === 0) {
          ready.push(config);
        } else {
          waiting.push(config);
        }
      }

      // Split into workers to spawn now vs queued for later
      const toSpawn = ready.slice(0, maxWorkers);
      const toQueue = [...ready.slice(maxWorkers), ...waiting];

      // Create worktrees and spawn worker sessions (with stagger)
      const launched: string[] = [];
      for (let i = 0; i < toSpawn.length; i++) {
        const config = toSpawn[i];
        const incompleteGoals = config.goals.filter((g) => !g.completed);
        const session = await createWorktree(config);
        await spawnSession(session, config);
        launched.push(`${config.name} (${incompleteGoals.length} goals)`);

        // Stagger spawning to avoid resource burst
        if (i < toSpawn.length - 1 && staggerMs > 0) {
          await new Promise(resolve => setTimeout(resolve, staggerMs));
        }
      }

      // Queue overflow tasks
      if (toQueue.length > 0) {
        await withQueueLock(cwd, async () => {
          const queue = await readQueue(cwd);
          for (const config of toQueue) {
            const id = generateMessageId();
            queue.items.push({
              id,
              topic: config.name,
              description: `Overflow from --max-workers: ${config.goals.filter((g) => !g.completed).map((g) => g.text).join("; ")}`,
              goals: config.goals
                .filter((g) => !g.completed)
                .map((g) => g.text),
              role: config.role,
              priority: 10,
              status: "pending",
              createdAt: new Date().toISOString(),
            });
          }
          await writeQueue(cwd, queue);
        });
      }

      // Create mailbox directories for each worker
      for (const config of configs) {
        await mkdir(mailboxPath(cwd, config.name), { recursive: true });
      }
      await mkdir(mailboxPath(cwd, "parent"), { recursive: true });
      await mkdir(mailboxPath(cwd, "manager"), { recursive: true });

      // Initialize worker registry
      const registryWorkers: Record<string, WorkerRegistryEntry> = {};
      for (const config of toSpawn) {
        const session = sessions.get(config.name);
        if (!session) continue;
        registryWorkers[config.name] = {
          name: config.name,
          role: config.role,
          branch: session.branch,
          worktreePath: session.worktreePath,
          status: "active",
          goalsTotal: config.goals.length,
          goalsCompleted: config.goals.filter((g) => g.completed).length,
          assignedQueueItems: [],
        };
      }
      await writeRegistry(cwd, {
        workers: registryWorkers,
        updatedAt: new Date().toISOString(),
      });

      // Spawn the manager session
      await spawnManager(configs);

      loopActive = true;
      launchStartedAt = new Date();
      managerRecoveryAttempts = 0;
      managerStaleCount = 0;
      await persistState();

      // If queue has pending items, notify manager
      const queue = await readQueue(cwd);
      const pendingItems = queue.items.filter((i) => i.status === "pending");
      if (pendingItems.length > 0) {
        await sendMailboxMessage(cwd, "manager", "parent", "directive", {
          text: `${pendingItems.length} pending queue item(s) awaiting dispatch`,
        });
      }

      ctx.ui.setStatus("harness", "harness: active");

      // Build detailed launch report
      const reportLines = [
        `## Harness Launched`,
        "",
        `**Workers:** ${launched.join(", ")} (${launched.length})`,
      ];
      if (skipped.length > 0) {
        reportLines.push(
          `**Skipped (all goals complete):** ${skipped.join(", ")} (${skipped.length})`,
        );
      }
      if (toQueue.length > 0) {
        reportLines.push(
          `**Queued (--max-workers ${maxWorkers}):** ${toQueue.map((c) => c.name).join(", ")} (${toQueue.length})`,
        );
      }
      reportLines.push("", "Manager session spawned to monitor progress.");

      pi.sendMessage(
        {
          customType: "harness-started",
          content: reportLines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:status", {
    description: "Show progress of all submodule launches",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      const configs = await readGoalFiles();

      if (configs.length === 0) {
        ctx.ui.notify("No goal files found in .pi-agent/", "info");
        return;
      }

      const summary = buildProgressSummary(configs);
      const managerStatus = await readManagerStatus(cwd);
      const statusLine = loopActive
        ? `Loop: active (manager: ${managerStatus?.status ?? "unknown"})`
        : "Loop: inactive";

      // Show which tasks have active workers vs just goal files, with tmux status
      const activeWorkers: string[] = [];
      const goalFilesOnly: string[] = [];
      for (const c of configs) {
        const session = sessions.get(c.name);
        if (session) {
          const tmuxAlive = session.tmuxSession ? await tmuxHasSession(session.tmuxSession) : false;
          activeWorkers.push(`${c.name} (tmux: ${tmuxAlive ? "alive" : "dead"})`);
        } else {
          goalFilesOnly.push(c.name);
        }
      }
      const managerTmuxAlive = managerTmuxSession ? await tmuxHasSession(managerTmuxSession) : false;
      const workerInfo = activeWorkers.length > 0
        ? `\nActive workers: ${activeWorkers.join(", ")}`
        : "";
      const goalOnlyInfo = goalFilesOnly.length > 0
        ? `\nGoal files only (no worker): ${goalFilesOnly.join(", ")}`
        : "";
      const tmuxInfo = loopActive
        ? `\nManager tmux: ${managerTmuxAlive ? "alive" : "dead"} | Server: \`tmux -L ${TMUX_SERVER}\``
        : "";

      const unanswered = configs.reduce(
        (sum, c) => sum + (c.questions?.filter((q) => !q.answered).length ?? 0),
        0,
      );
      const questionAlert =
        unanswered > 0
          ? `\n\n**${unanswered} unanswered question(s)** — use \`harness_answer\` to respond.`
          : "";

      pi.sendMessage(
        {
          customType: "harness-status",
          content: `${summary}\n${statusLine}${workerInfo}${goalOnlyInfo}${tmuxInfo}${questionAlert}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:stop", {
    description: "Write stop signal to gracefully stop the manager",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      if (!loopActive) {
        ctx.ui.notify("Harness is not active", "info");
        return;
      }

      // Write stop signal for manager
      try {
        await mkdir(piAgentDir(), { recursive: true });
        await writeFile(
          join(cwd, STOP_SIGNAL_FILE),
          new Date().toISOString() + "\n",
          "utf-8",
        );
      } catch (e) {
        ctx.ui.notify(
          `Failed to write stop signal: ${e instanceof Error ? e.message : String(e)}`,
          "warning",
        );
      }

      // Kill all worker tmux sessions
      for (const [, session] of sessions) {
        if (session.tmuxSession) {
          await tmuxKillSession(session.tmuxSession);
          session.tmuxSession = null;
          session.spawned = false;
        }
      }

      // Kill manager tmux session
      if (managerTmuxSession) {
        await tmuxKillSession(managerTmuxSession);
        managerTmuxSession = null;
      }

      // Write run summary before deactivating
      await writeRunSummary("user_stop");

      // Clean up BMAD prompt files if they exist
      try {
        await rm(join(cwd, PI_AGENT_DIR, ".prompts"), { recursive: true, force: true });
      } catch {
        // May not exist
      }

      loopActive = false;
      invalidateCache();
      await persistState();
      ctx.ui.setStatus("harness", undefined);
    },
  });

  pi.registerCommand("harness:init", {
    description:
      "Scaffold .pi-agent/ directory with mailbox structure",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      // Create directory structure
      await mkdir(piAgentDir(), { recursive: true });
      await mkdir(mailboxPath(cwd, "parent"), { recursive: true });
      await mkdir(mailboxPath(cwd, "manager"), { recursive: true });

      // Check for existing goal files
      const configs = await readGoalFiles();

      pi.sendMessage(
        {
          customType: "harness-init",
          content: [
            `## Harness Init`,
            "",
            "Scaffolded `.pi-agent/` directory with mailbox structure.",
            "",
            configs.length > 0
              ? `Found ${configs.length} existing task(s): ${configs.map((c) => c.name).join(", ")}`
              : "No tasks yet. Use `/harness:add <name> [goals...]` to create tasks.",
            "",
            "Then run `/harness:launch` to start workers.",
          ].join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:merge", {
    description:
      "Merge a specific submodule's worktree branch back (pass submodule name)",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      const name = args?.trim();

      if (!name) {
        ctx.ui.notify("Usage: /harness:merge <submodule-name>", "warning");
        return;
      }

      const session = sessions.get(name);
      if (!session) {
        ctx.ui.notify(`No active session for "${name}"`, "warning");
        return;
      }

      const configs = await readGoalFiles();
      const config = configs.find((c) => c.name === name);
      if (!config) {
        ctx.ui.notify(`No goal file for "${name}"`, "warning");
        return;
      }

      const result = await mergeWorktree(session, config);

      // Only clean up session on successful merge
      if (result.ok) {
        sessions.delete(name);
        invalidateCache();
        await persistState();
      }

      pi.sendMessage(
        {
          customType: "harness-merge-result",
          content: result.message,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:recover", {
    description: "Respawn a stale or dead manager session. Use --force to reset recovery counters.",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      const force = (args ?? "").includes("--force");

      if (!loopActive) {
        ctx.ui.notify("No active harness to recover", "warning");
        return;
      }

      const configs = await readGoalFiles();
      if (configs.length === 0) {
        ctx.ui.notify("No goal files found in .pi-agent/", "warning");
        return;
      }

      // Reset recovery counters if --force
      if (force) {
        managerRecoveryAttempts = 0;
        managerStaleCount = 0;
      }

      // Kill old manager tmux session
      if (managerTmuxSession) {
        await tmuxKillSession(managerTmuxSession);
        managerTmuxSession = null;
      }

      // Preserve error log before deleting manager directory
      try {
        const errorLogPath = join(managerDirPath(), ".pi-agent-errors.log");
        const prevPath = join(cwd, ".pi-agent-errors.log.prev");
        await copyFile(errorLogPath, prevPath);
      } catch { /* no error log to preserve */ }

      // Clean up old manager directory
      try {
        await rm(managerDirPath(), { recursive: true, force: true });
      } catch {
        // May not exist
      }

      // Clean up old stop signal (so the new manager doesn't immediately stop)
      try {
        await rm(join(cwd, STOP_SIGNAL_FILE));
      } catch {
        // May not exist
      }

      // Respawn manager
      await spawnManager(configs);
      await persistState();

      ctx.ui.setStatus("harness", "harness: active");
      ctx.ui.notify(force ? "Manager respawned (counters reset)" : "Manager respawned", "info");
    },
  });

  pi.registerCommand("harness:add", {
    description:
      "Create a standalone worktree task: /harness:add <name> [goals...]",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /harness:add <name> [goal1, goal2, ...]",
          "warning",
        );
        return;
      }

      // Parse --role <name> flag before splitting name and goals
      let roleArg = "developer";
      let remaining = trimmed;
      const roleFlag = remaining.match(/--role\s+(\S+)/);
      if (roleFlag) {
        const parsed = roleFlag[1].toLowerCase();
        if (HARNESS_ROLES.some((r) => r.name === parsed)) {
          roleArg = parsed;
        }
        remaining = remaining.replace(roleFlag[0], "").trim();
      }

      // First token is the name, rest are goals (comma-separated or single string)
      const spaceIdx = remaining.indexOf(" ");
      const name = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);
      const goalsRaw =
        spaceIdx === -1 ? "" : remaining.slice(spaceIdx + 1).trim();

      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
        ctx.ui.notify(
          `Invalid task name "${name}". Use kebab-case (e.g., "refactor-auth").`,
          "warning",
        );
        return;
      }

      const gfn = goalFileName(name);
      const goalFile = join(piAgentDir(), gfn);
      try {
        await readFile(goalFile, "utf-8");
        ctx.ui.notify(
          `Task "${name}" already exists at .pi-agent/${gfn}`,
          "warning",
        );
        return;
      } catch {
        // File doesn't exist — proceed
      }

      const goals: SubmoduleGoal[] = goalsRaw
        ? goalsRaw
            .split(",")
            .map((g) => g.trim())
            .filter((g) => g.length > 0)
            .map((g) => ({ text: g, completed: false }))
        : [{ text: "Define goals for this task", completed: false }];

      const config: SubmoduleConfig = {
        name,
        path: ".",
        role: roleArg,
        goals,
        questions: [],
        context: "",
        rawContent: "",
      };

      const content = serializeGoalFile(config);
      try {
        await mkdir(piAgentDir(), { recursive: true });
        await atomicWriteFile(goalFile, content);
      } catch (e) {
        ctx.ui.notify(
          `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }
      invalidateCache();

      pi.sendMessage(
        {
          customType: "harness-add",
          content: [
            `## Task Added: ${name}`,
            "",
            `Created \`.pi-agent/${gfn}\` with ${goals.length} goal(s):`,
            ...goals.map((g) => `- [ ] ${g.text}`),
            "",
            "Run `/harness:launch` to start workers.",
          ].join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );

      // If harness is active, create worker mailbox and notify manager
      if (loopActive) {
        await mkdir(mailboxPath(cwd, name), { recursive: true });
        await sendMailboxMessage(cwd, "manager", "parent", "directive", {
          text: `New worker added: ${name}`,
          worker: name,
          role: roleArg,
        });
      }
    },
  });

  pi.registerCommand("harness:cleanup", {
    description:
      "Remove all worktrees, branches, and state files. Use --force to skip dirty checks.",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      const force = (args ?? "").trim() === "--force";

      // Check for dirty worktrees if not forcing
      if (!force) {
        const dirty: string[] = [];
        for (const [name, session] of sessions) {
          try {
            const result = await pi.exec(
              "git",
              ["-C", session.worktreePath, "status", "--porcelain"],
              { cwd },
            );
            if (result.stdout && result.stdout.trim().length > 0) {
              dirty.push(name);
            }
          } catch {
            // Worktree may already be gone
          }
        }
        if (dirty.length > 0) {
          pi.sendMessage(
            {
              customType: "harness-cleanup-blocked",
              content: [
                "## Cleanup Blocked",
                "",
                "The following worktrees have uncommitted changes:",
                ...dirty.map((d) => `- ${d}`),
                "",
                "Run `/harness:cleanup --force` to remove them anyway.",
              ].join("\n"),
              display: true,
            },
            { triggerTurn: false },
          );
          return;
        }
      }

      const removed: string[] = [];
      const failed: string[] = [];

      // Remove worktrees and branches (in-memory sessions)
      for (const [name, session] of sessions) {
        try {
          await removeWorktree(session, force);
          removed.push(name);
        } catch {
          failed.push(name);
        }
      }

      // Remove orphaned worktrees not in in-memory sessions (crash recovery)
      try {
        const wtList = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd });
        const blocks = (wtList.stdout ?? "").split("\n\n").filter(Boolean);
        for (const block of blocks) {
          const pathMatch = block.match(/^worktree\s+(.+)$/m);
          if (!pathMatch) continue;
          const wtPath = pathMatch[1];
          if (wtPath.includes(WORKTREE_DIR) && !Array.from(sessions.values()).some(s => s.worktreePath === wtPath)) {
            try {
              const rmArgs = ["worktree", "remove", wtPath];
              if (force) rmArgs.push("--force");
              await pi.exec("git", rmArgs, { cwd });
              removed.push(`orphaned: ${wtPath}`);
              // Also delete the associated branch
              const wtName = wtPath.split("/").pop();
              if (wtName) {
                try {
                  await pi.exec("git", ["branch", force ? "-D" : "-d", `pi-agent/${wtName}`], { cwd });
                } catch { /* branch may not exist or already deleted */ }
              }
            } catch {
              failed.push(`orphaned: ${wtPath}`);
            }
          }
        }
      } catch {
        // git worktree list may fail
      }

      // Remove manager directory
      try {
        await rm(managerDirPath(), { recursive: true, force: true });
      } catch {
        // May not exist
      }

      // Remove state files
      const stateFiles = [
        QUEUE_FILE,
        REGISTRY_FILE,
        LAUNCH_STATE_FILE,
        STOP_SIGNAL_FILE,
        MANAGER_STATUS_FILE,
        SUMMARY_FILE,
      ];
      for (const file of stateFiles) {
        try {
          await rm(join(cwd, file));
        } catch {
          // May not exist
        }
      }

      // Remove mailboxes directory
      try {
        await rm(join(cwd, MAILBOX_DIR), { recursive: true, force: true });
      } catch {
        // May not exist
      }

      // Remove BMAD pre-generated prompts and mode file
      try {
        await rm(join(cwd, PI_AGENT_DIR, ".prompts"), { recursive: true, force: true });
      } catch {
        // May not exist
      }
      try {
        await rm(join(cwd, PI_AGENT_DIR, ".bmad-mode.json"));
      } catch {
        // May not exist
      }

      // Kill entire tmux server
      await tmuxKillServer();

      // Reset in-memory state
      sessions.clear();
      loopActive = false;
      managerSpawned = false;
      managerSpawnedAt = null;
      managerTmuxSession = null;
      managerRecoveryAttempts = 0;
      invalidateCache();
      ctx.ui.setStatus("harness", undefined);

      pi.sendMessage(
        {
          customType: "harness-cleanup",
          content: [
            "## Harness Cleaned Up",
            "",
            removed.length > 0
              ? `Removed worktrees: ${removed.join(", ")}`
              : "No worktrees to remove.",
            failed.length > 0
              ? `Failed to remove: ${failed.join(", ")}`
              : "",
            "State files and mailboxes cleared.",
          ]
            .filter((l) => l.length > 0)
            .join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:attach", {
    description: "Attach to a worker or manager tmux session: /harness:attach <name|manager>",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      const target = (args ?? "").trim();

      if (!target) {
        // List available sessions
        const available = await tmuxListSessions();
        pi.sendMessage({
          customType: "harness-sessions",
          content: available.length > 0
            ? `Available sessions:\n${available.map(s => `- ${s}`).join("\n")}\n\nRun: \`tmux -L ${TMUX_SERVER} attach -t <name>\``
            : "No active tmux sessions.",
          display: true,
        }, { triggerTurn: false });
        return;
      }

      const sessionName = target === "manager" ? "harness-manager" : `worker-${target}`;
      const alive = await tmuxHasSession(sessionName);
      if (!alive) {
        ctx.ui.notify(`Session "${sessionName}" not found or not running`, "warning");
        return;
      }

      pi.sendMessage({
        customType: "harness-attach",
        content: `To attach: \`tmux -L ${TMUX_SERVER} attach -t ${sessionName}\``,
        display: true,
      }, { triggerTurn: false });
    },
  });

  pi.registerCommand("harness:logs", {
    description: "Show recent output from a worker or manager: /harness:logs <name|manager> [lines]",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      const parts = (args ?? "").trim().split(/\s+/);
      const target = parts[0] ?? "";
      const lines = parseInt(parts[1] ?? "100", 10);

      if (!target) {
        ctx.ui.notify("Usage: /harness:logs <name|manager> [lines]", "info");
        return;
      }

      const sessionName = target === "manager" ? "harness-manager" : `worker-${target}`;
      const output = await tmuxCapture(sessionName, lines);
      if (!output) {
        ctx.ui.notify(`No output from "${sessionName}" (session may be dead)`, "warning");
        return;
      }

      pi.sendMessage({
        customType: "harness-logs",
        content: `## Logs: ${sessionName}\n\n\`\`\`\n${output}\n\`\`\``,
        display: true,
      }, { triggerTurn: false });
    },
  });

  pi.registerCommand("harness:queue", {
    description:
      "Add work to the queue: /harness:queue [--role <name>] [--priority <n>] <topic> [goals...]",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;
      let remaining = (args ?? "").trim();

      if (!remaining) {
        ctx.ui.notify(
          "Usage: /harness:queue [--role <name>] [--priority <n>] <topic> [goals...]",
          "warning",
        );
        return;
      }

      // Parse --role flag
      let roleArg: string | undefined;
      const roleFlag = remaining.match(/--role\s+(\S+)/);
      if (roleFlag) {
        roleArg = roleFlag[1].toLowerCase();
        remaining = remaining.replace(roleFlag[0], "").trim();
      }

      // Parse --priority flag
      let priority = 10;
      const priorityFlag = remaining.match(/--priority\s+(\d+)/);
      if (priorityFlag) {
        priority = parseInt(priorityFlag[1], 10);
        remaining = remaining.replace(priorityFlag[0], "").trim();
      }

      // First token is topic, rest are goals (comma-separated)
      const spaceIdx = remaining.indexOf(" ");
      const topic = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);
      const goalsRaw =
        spaceIdx === -1 ? "" : remaining.slice(spaceIdx + 1).trim();

      const goals = goalsRaw
        ? goalsRaw
            .split(",")
            .map((g) => g.trim())
            .filter((g) => g.length > 0)
        : undefined;

      const id = generateMessageId();
      const queueLength = await withQueueLock(cwd, async () => {
        const queue = await readQueue(cwd);
        const item: QueueItem = {
          id,
          topic,
          description: goalsRaw || topic,
          goals,
          role: roleArg,
          priority,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        queue.items.push(item);
        await writeQueue(cwd, queue);
        return queue.items.length;
      });
      invalidateCache();

      // Notify manager
      if (loopActive) {
        await sendMailboxMessage(cwd, "manager", "parent", "directive", {
          text: `New queue item: ${topic}`,
          queueItemId: id,
        });
      }

      pi.sendMessage(
        {
          customType: "harness-queue",
          content: [
            `## Work Queued: ${topic}`,
            "",
            `ID: ${id}`,
            `Priority: ${priority}`,
            ...(roleArg ? [`Role: ${roleArg}`] : []),
            ...(goals ? [`Goals: ${goals.join(", ")}`] : []),
            "",
            `Queue now has ${queueLength} item(s).`,
          ].join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:inbox", {
    description: "Read all messages in the parent's mailbox",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      const messages = await readMailbox(cwd, "parent");

      if (messages.length === 0) {
        ctx.ui.notify("No messages in parent inbox.", "info");
        return;
      }

      const lines: string[] = [
        `## Parent Inbox (${messages.length} message(s))`,
        "",
      ];
      for (const { message, filename } of messages) {
        lines.push(
          `**[${message.type}]** from ${message.from} at ${message.timestamp}`,
        );
        lines.push(`Payload: ${JSON.stringify(message.payload)}`);
        lines.push("");
        await deleteMessage(cwd, "parent", filename);
      }

      pi.sendMessage(
        {
          customType: "harness-inbox",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("harness:dashboard", {
    description: "Show comprehensive harness dashboard with all workers, queue, and health",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      const configs = await readGoalFiles();
      const managerStatus = await readManagerStatus(cwd);
      const queue = await readQueue(cwd);
      const parentInbox = await readMailbox(cwd, "parent");

      const lines: string[] = ["## Harness Dashboard", ""];

      // --- Manager Section ---
      lines.push("### Manager");
      lines.push("| Field | Value |");
      lines.push("|-------|-------|");
      const mgrTmuxAlive = managerTmuxSession ? await tmuxHasSession(managerTmuxSession) : false;
      lines.push(`| Status | ${managerStatus?.status ?? "unknown"} (tmux: ${mgrTmuxAlive ? "alive" : "dead"}) |`);
      lines.push(`| Recovery | ${managerRecoveryAttempts}/${MAX_MANAGER_RECOVERY} attempts |`);
      lines.push(`| Stale count | ${managerStaleCount} |`);

      // Show error log
      let errorLines: string[] = [];
      try {
        const errorLog = await readFile(join(cwd, MANAGER_DIR, ".pi-agent-errors.log"), "utf-8");
        errorLines = errorLog.trim().split("\n").filter(Boolean);
      } catch { /* no errors */ }
      lines.push(`| Errors | ${errorLines.length > 0 ? errorLines.length + " logged" : "none"} |`);
      lines.push("");

      // --- Workers Section ---
      let activeCount = 0;
      let stalledCount = 0;
      let deadCount = 0;
      const workerRows: string[] = [];

      for (const config of configs) {
        const session = sessions.get(config.name);
        const sidecar = await readWorkerState(config.name);

        let statusStr = "no worker";
        let tmuxStr = "—";
        let lastActivityStr = "—";

        if (session) {
          if (session.tmuxSession) {
            const activity = await peekWorkerActivity(session);
            statusStr = activity;
            tmuxStr = "alive";
            if (activity === "active") activeCount++;
            else if (activity === "stalled") stalledCount++;
            else deadCount++;
          } else {
            statusStr = "dead";
            tmuxStr = "dead";
            deadCount++;
          }
        } else if (sidecar) {
          statusStr = sidecar.status;
          if (sidecar.status === "completed") statusStr = "done";
        }

        if (sidecar?.lastActivity) {
          const elapsed = Date.now() - new Date(sidecar.lastActivity).getTime();
          const minutes = Math.round(elapsed / 60000);
          lastActivityStr = minutes < 1 ? "<1m ago" : `${minutes}m ago`;
        }

        const mergeStr = sidecar?.mergeStatus ?? "—";
        const done = config.goals.filter(g => g.completed).length;
        workerRows.push(
          `| ${config.name} | ${done}/${config.goals.length} | ${statusStr} | ${tmuxStr} | ${lastActivityStr} | ${mergeStr} |`,
        );
      }

      lines.push(`### Workers (${activeCount} active, ${stalledCount} stalled, ${deadCount} dead)`);
      lines.push("| Worker | Goals | Status | Tmux | Last Activity | Merge |");
      lines.push("|--------|-------|--------|------|---------------|-------|");
      lines.push(...workerRows);
      lines.push("");

      // --- Queue Section ---
      const pending = queue.items.filter(i => i.status === "pending");
      const dispatched = queue.items.filter(i => i.status === "dispatched");
      lines.push(`### Queue (${pending.length} pending, ${dispatched.length} dispatched)`);
      if (queue.items.length > 0) {
        lines.push("| Item | Assigned | Status |");
        lines.push("|------|----------|--------|");
        for (const item of queue.items) {
          lines.push(`| ${item.topic} | ${item.assignedTo ?? "—"} | ${item.status} |`);
        }
      } else {
        lines.push("No queue items.");
      }
      lines.push("");

      // --- Questions Section ---
      const allUnanswered: Array<{ worker: string; question: string }> = [];
      for (const config of configs) {
        for (const q of config.questions?.filter(q => !q.answered) ?? []) {
          allUnanswered.push({ worker: config.name, question: q.text });
        }
      }
      if (allUnanswered.length > 0) {
        lines.push(`### Questions (${allUnanswered.length} unanswered)`);
        lines.push("| Worker | Question |");
        lines.push("|--------|----------|");
        for (const { worker, question } of allUnanswered) {
          lines.push(`| ${worker} | ${question} |`);
        }
      } else {
        lines.push("### Questions (0 unanswered)");
      }
      lines.push("");

      // --- Recent Errors Section ---
      if (errorLines.length > 0) {
        lines.push("### Recent Errors");
        lines.push("```");
        lines.push(...errorLines.slice(-5));
        lines.push("```");
      }
      lines.push("");

      // --- Inbox Section ---
      if (parentInbox.length > 0) {
        lines.push(`### Parent Inbox (${parentInbox.length} message(s))`);
        for (const { message } of parentInbox) {
          lines.push(`- **[${message.type}]** from ${message.from}: ${JSON.stringify(message.payload)}`);
        }
      }

      pi.sendMessage(
        {
          customType: "harness-dashboard",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- BMAD Command ---

  pi.registerCommand("harness:bmad", {
    description:
      "Run full BMAD methodology via harness workers. Supports --max-workers N.",
    handler: async (args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      if (loopActive) {
        ctx.ui.notify(
          "Harness is already active. Stop it first with /harness:stop.",
          "warning",
        );
        return;
      }

      // Parse --max-workers flag
      let maxWorkers = 3;
      const remaining = (args ?? "").trim();
      const maxFlag = remaining.match(/--max-workers\s+(\d+)/);
      if (maxFlag) {
        maxWorkers = parseInt(maxFlag[1], 10);
      }

      // Load BMAD config
      const bmadConfig = await loadBmadConfig(cwd);
      if (!bmadConfig) {
        ctx.ui.notify(
          "No BMAD configuration found. Run /bmad-init first.",
          "error",
        );
        return;
      }

      // Load BMAD status — guard against malformed status files that would
      // silently return [] and cause already-completed workflows to relaunch.
      const bmadStatus = await loadBmadStatus(cwd, bmadConfig);
      if (bmadStatus.length === 0) {
        const statusPath = join(cwd, bmadConfig.workflowStatusFile);
        let fileExists = false;
        try {
          await stat(statusPath);
          fileExists = true;
        } catch {
          // File doesn't exist — fresh project, no status yet (expected)
        }
        if (fileExists) {
          ctx.ui.notify(
            `Warning: BMAD status file exists at ${bmadConfig.workflowStatusFile} but yielded 0 workflow entries. ` +
              "The file may be malformed. All workflows will be treated as incomplete.",
            "warning",
          );
        }
      }

      // Build workflow DAG
      const dag = buildBmadWorkflowDag(
        bmadConfig.projectLevel,
        bmadStatus,
        WORKFLOW_DEFS,
      );

      if (dag.length === 0) {
        ctx.ui.notify("All BMAD workflows are already complete!", "info");
        return;
      }

      // Clean up leftover stop signal
      try {
        await rm(join(cwd, STOP_SIGNAL_FILE));
      } catch { /* no signal to clean */ }

      // Generate goal files and prompt files for each workflow
      const promptsDir = join(piAgentDir(), ".prompts");
      await mkdir(piAgentDir(), { recursive: true });
      await mkdir(promptsDir, { recursive: true });

      const allConfigs: SubmoduleConfig[] = [];
      for (const spec of dag) {
        const workerName = `${BMAD_PREFIX}${spec.workflowName}`;
        const config: SubmoduleConfig = {
          name: workerName,
          path: ".",
          role: spec.role,
          goals: spec.goals.map((g) => ({ text: g, completed: false })),
          questions: [],
          context: `BMAD workflow: ${spec.workflowName} (Phase ${spec.phase}, Agent: ${spec.bmadAgent})`,
          rawContent: "",
          dependsOn: spec.dependsOn.map((d) => `${BMAD_PREFIX}${d}`),
        };
        allConfigs.push(config);

        // Write goal file
        const goalContent = serializeGoalFile(config);
        await atomicWriteFile(
          join(piAgentDir(), goalFileName(workerName)),
          goalContent,
        );

        // Pre-generate prompt file
        const promptContent = buildBmadWorkerPrompt(spec, bmadConfig, bmadStatus);
        await atomicWriteFile(
          join(promptsDir, `${workerName}.md`),
          promptContent,
        );
      }

      // Write .bmad-mode.json metadata
      const bmadModeData = {
        enabled: true,
        projectLevel: bmadConfig.projectLevel,
        projectName: bmadConfig.projectName,
        statusFile: bmadConfig.workflowStatusFile,
        maxWorkers: maxWorkers === Infinity ? null : maxWorkers,
        workflows: dag.map((spec) => ({
          name: `${BMAD_PREFIX}${spec.workflowName}`,
          workflowName: spec.workflowName,
          phase: spec.phase,
          dependsOn: spec.dependsOn.map((d) => `${BMAD_PREFIX}${d}`),
          status: "pending" as const,
        })),
      };
      await atomicWriteFile(
        join(piAgentDir(), ".bmad-mode.json"),
        JSON.stringify(bmadModeData, null, 2),
      );

      // Separate into ready (no unmet deps) vs waiting — a dep is only
      // "unmet" if it refers to another config in this launch (i.e. it's
      // still pending). Deps pointing to already-completed or out-of-plan
      // workflows are considered satisfied.
      const allConfigNames = new Set(allConfigs.map((c) => c.name));
      const ready: SubmoduleConfig[] = [];
      const waiting: SubmoduleConfig[] = [];
      for (const config of allConfigs) {
        const unmetDeps = (config.dependsOn ?? []).filter((d) =>
          allConfigNames.has(d),
        );
        if (unmetDeps.length === 0) {
          ready.push(config);
        } else {
          waiting.push(config);
        }
      }

      // Spawn ready workers (up to max-workers)
      const toSpawn = ready.slice(0, maxWorkers);
      const toQueue = [...ready.slice(maxWorkers), ...waiting];

      const launched: string[] = [];
      for (let i = 0; i < toSpawn.length; i++) {
        const config = toSpawn[i];
        const session = await createWorktree(config);

        // Copy pre-generated prompt into worktree
        const promptSrc = join(promptsDir, `${config.name}.md`);
        const promptDst = join(session.worktreePath, ".pi-agent-prompt.md");
        await copyFile(promptSrc, promptDst);
        await addToWorktreeExclude(session.worktreePath, ".pi-agent-prompt.md");

        // NOTE: heartbeat.md is already written by createWorktree() above

        // Spawn tmux session
        const tmuxName = `worker-${sanitizeTmuxName(config.name)}`;
        const cmd = `pi -p "$(cat .pi-agent-prompt.md)"`;
        await tmuxNewSession(tmuxName, cmd, session.worktreePath);

        session.tmuxSession = tmuxName;
        session.spawned = true;
        session.spawnedAt = new Date();

        await writeWorkerState(config.name, {
          name: config.name,
          status: "active",
          goalsCompleted: 0,
          goalsTotal: config.goals.length,
          lastActivity: new Date().toISOString(),
          errors: [],
          mergeStatus: "pending",
          dependsOn: config.dependsOn ?? [],
          dependenciesMet: true,
        });

        // Update .bmad-mode.json workflow status
        const modeData = bmadModeData.workflows.find((w) => w.name === config.name);
        if (modeData) modeData.status = "active";

        launched.push(`${config.name} (Phase ${dag.find((s) => `${BMAD_PREFIX}${s.workflowName}` === config.name)?.phase})`);

        if (i < toSpawn.length - 1) {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }

      // Queue waiting workers
      if (toQueue.length > 0) {
        await withQueueLock(cwd, async () => {
          const queue = await readQueue(cwd);
          for (const config of toQueue) {
            const id = generateMessageId();
            queue.items.push({
              id,
              topic: config.name,
              description: `BMAD workflow: ${config.goals.map((g) => g.text).join("; ")}`,
              goals: config.goals.map((g) => g.text),
              role: config.role,
              priority: 10,
              status: "pending",
              createdAt: new Date().toISOString(),
            });
          }
          await writeQueue(cwd, queue);
        });
      }

      // Re-write .bmad-mode.json with updated statuses
      await atomicWriteFile(
        join(piAgentDir(), ".bmad-mode.json"),
        JSON.stringify(bmadModeData, null, 2),
      );

      // Create mailbox directories
      for (const config of allConfigs) {
        await mkdir(mailboxPath(cwd, config.name), { recursive: true });
      }
      await mkdir(mailboxPath(cwd, "parent"), { recursive: true });
      await mkdir(mailboxPath(cwd, "manager"), { recursive: true });

      // Initialize worker registry
      const registryWorkers: Record<string, WorkerRegistryEntry> = {};
      for (const config of toSpawn) {
        const session = sessions.get(config.name);
        if (!session) continue;
        registryWorkers[config.name] = {
          name: config.name,
          role: config.role,
          branch: session.branch,
          worktreePath: session.worktreePath,
          status: "active",
          goalsTotal: config.goals.length,
          goalsCompleted: 0,
          assignedQueueItems: [],
        };
      }
      await writeRegistry(cwd, {
        workers: registryWorkers,
        updatedAt: new Date().toISOString(),
      });

      // Spawn manager with BMAD-enhanced instructions
      const bmadModeConfig: BmadModeConfig = {
        projectLevel: bmadConfig.projectLevel,
        projectName: bmadConfig.projectName,
        statusFile: bmadConfig.workflowStatusFile,
        maxWorkers: maxWorkers === Infinity ? undefined : maxWorkers,
        workflows: dag.map((spec) => ({
          name: `${BMAD_PREFIX}${spec.workflowName}`,
          workflowName: spec.workflowName,
          phase: spec.phase,
          dependsOn: spec.dependsOn.map((d) => `${BMAD_PREFIX}${d}`),
        })),
      };
      await spawnManager(allConfigs, bmadModeConfig);

      loopActive = true;
      launchStartedAt = new Date();
      managerRecoveryAttempts = 0;
      managerStaleCount = 0;
      await persistState();

      // Notify manager about queued items
      const queue = await readQueue(cwd);
      const pendingItems = queue.items.filter((i) => i.status === "pending");
      if (pendingItems.length > 0) {
        await sendMailboxMessage(cwd, "manager", "parent", "directive", {
          text: `${pendingItems.length} BMAD workflow(s) queued awaiting dependency completion`,
        });
      }

      ctx.ui.setStatus("harness", "harness: bmad active");

      // Build launch report
      const reportLines = [
        `## BMAD Harness Launched`,
        "",
        `**Project:** ${bmadConfig.projectName} (Level ${bmadConfig.projectLevel})`,
        `**Workers:** ${launched.join(", ")} (${launched.length})`,
      ];
      if (toQueue.length > 0) {
        reportLines.push(
          `**Queued (dependencies/overflow):** ${toQueue.map((c) => c.name).join(", ")} (${toQueue.length})`,
        );
      }
      reportLines.push(
        "",
        `**Total workflows:** ${dag.length}`,
        "",
        "Manager session spawned with BMAD phase management.",
      );

      pi.sendMessage(
        {
          customType: "harness-bmad-started",
          content: reportLines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
