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
 *
 * Events:
 *   session_start      - Load config, restore state, read manager status
 *   turn_end           - Lightweight: read manager status, update status bar
 *   session_shutdown   - Persist state
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFile, writeFile, readdir, mkdir, rm, rename } from "fs/promises";
import { join, resolve } from "path";

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
];

export function getRole(name: string): HarnessRole {
  return HARNESS_ROLES.find((r) => r.name === name) ?? HARNESS_ROLES[0];
}

export interface SubmoduleSession {
  name: string;
  worktreePath: string;
  branch: string;
  spawned: boolean;
  spawnedAt: Date | null;
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
    }
  >;
  managerSpawned: boolean;
  managerCwd: string;
  managerSpawnedAt: string | null;
}

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

// --- Validation Schemas (Typebox) ---

const LaunchStateSchema = Type.Object({
  active: Type.Boolean(),
  sessions: Type.Record(
    Type.String(),
    Type.Object({
      worktreePath: Type.String(),
      branch: Type.String(),
      spawned: Type.Boolean(),
      spawnedAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  managerSpawned: Type.Boolean(),
  managerCwd: Type.String(),
  managerSpawnedAt: Type.Union([Type.String(), Type.Null()]),
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

/** Derive goal filename from a config/task name. Single source of truth. */
export function goalFileName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-") + ".md";
}

/** Write file atomically: write to temp, then rename (POSIX-atomic). */
async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tmp = filePath + ".tmp." + process.pid;
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

  // Tier 3: bidirectional substring match
  const substring = items.filter((item) => {
    const t = getText(item).toLowerCase();
    return t.includes(q) || q.includes(t);
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
  for (let i = 0; i < 4; i++) {
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

  // Extract name from # heading, fallback to filename
  let name = filename.replace(/\.md$/, "");
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    name = headingMatch[1].trim();
  }

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

  return { name, path, role, goals, questions, context, rawContent: content };
}

export function serializeGoalFile(config: SubmoduleConfig): string {
  const lines: string[] = [];
  lines.push(`# ${config.name}`);
  lines.push(`path: ${config.path}`);
  if (config.role && config.role !== "developer") {
    lines.push(`role: ${config.role}`);
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

    goalSections.push(
      [
        `### ${config.name}`,
        `Path: ${config.path}`,
        ...(roleInfo ? [roleInfo] : []),
        branchInfo,
        "",
        goalList,
        ...questionLines,
      ].join("\n"),
    );
  }

  const piAgentPath = resolve(baseCwd, PI_AGENT_DIR);
  const statusFilePath = resolve(baseCwd, MANAGER_STATUS_FILE);
  const stopSignalPath = resolve(baseCwd, STOP_SIGNAL_FILE);

  // Build role awareness section if any workers have non-default roles
  const roleSummaries: string[] = [];
  for (const config of configs) {
    const role = getRole(config.role);
    roleSummaries.push(`- **${config.name}** — ${role.label}: ${role.persona}`);
  }

  return [
    "You are the Launch Manager for a multi-submodule development orchestration.",
    "",
    "## Your Job",
    "Monitor worker sessions across submodules, track their progress, and auto-merge completed branches.",
    "",
    "## Current Submodules",
    ...goalSections,
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
    "- Always write the status file after each check, even if nothing changed",
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

  // Last context reference for notifying on background errors
  let lastCtx: { ui: { notify: Function; setStatus: Function } } | null = null;

  // Cache for turn_end reads (recommendation 8)
  let cachedManagerStatus: {
    data: ManagerStatusFile | null;
    at: number;
  } | null = null;
  let cachedGoalConfigs: {
    data: SubmoduleConfig[];
    at: number;
  } | null = null;
  const CACHE_TTL_MS = 15_000;

  function invalidateCache(): void {
    cachedManagerStatus = null;
    cachedGoalConfigs = null;
  }

  // --- Helpers ---

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

  function buildManagerHeartbeatMd(): string {
    return [
      "# Launch Manager",
      "interval: 2m",
      "",
      "## Tasks",
      "- [ ] Monitor submodule worker progress and merge completed branches",
      "",
    ].join("\n");
  }

  async function persistState(): Promise<void> {
    const state: LaunchState = {
      active: loopActive,
      sessions: {},
      managerSpawned,
      managerCwd: managerDirPath(),
      managerSpawnedAt: managerSpawnedAt?.toISOString() ?? null,
    };
    for (const [name, session] of sessions) {
      state.sessions[name] = {
        worktreePath: session.worktreePath,
        branch: session.branch,
        spawned: session.spawned,
        spawnedAt: session.spawnedAt?.toISOString() ?? null,
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
      sessions = new Map();
      for (const [name, s] of Object.entries(state.sessions)) {
        sessions.set(name, {
          name,
          worktreePath: s.worktreePath,
          branch: s.branch,
          spawned: s.spawned,
          spawnedAt: s.spawnedAt ? new Date(s.spawnedAt) : null,
        });
      }
    } catch {
      // No saved state — first run
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
        // Branch and worktree already exist, that's fine
      }
    }

    // Write heartbeat.md into the worktree (untracked working file for
    // the heartbeat extension — should NOT be committed/merged).
    const heartbeatContent = buildHeartbeatMd(config);
    try {
      await writeFile(join(wtPath, "heartbeat.md"), heartbeatContent, "utf-8");
      // Ensure heartbeat.md is gitignored so workers' `git add .` won't
      // pick it up and cause merge conflicts across parallel worktrees.
      const gitignorePath = join(wtPath, ".gitignore");
      let existing = "";
      try {
        existing = await readFile(gitignorePath, "utf-8");
      } catch {
        // No .gitignore yet
      }
      if (!existing.includes("heartbeat.md")) {
        const separator = existing && !existing.endsWith("\n") ? "\n" : "";
        await writeFile(
          gitignorePath,
          existing + separator + "heartbeat.md\n",
          "utf-8",
        );
      }
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
    };
    sessions.set(name, session);
    return session;
  }

  function spawnSession(
    session: SubmoduleSession,
    config: SubmoduleConfig,
  ): void {
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
      "- Update heartbeat.md as you complete tasks",
      "- Do not switch branches",
      "",
      "## Asking Questions",
      `If you need a decision or clarification from the user, write your question to the goal file at \`${goalFilePath}\`.`,
      "Append to the `## Questions` section using the format: `- ? Your question here`",
      "Then periodically re-read the goal file to check for answers (lines starting with `- !`).",
      "",
      "## Mailbox",
      `Your inbox is at \`${resolve(cwd, MAILBOX_DIR, config.name)}/\`.`,
      "On each heartbeat cycle, read all *.json files in your inbox directory, sorted by filename.",
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

    pi.exec("pi", ["-p", prompt], {
      cwd: session.worktreePath,
      background: true,
    });

    session.spawned = true;
    session.spawnedAt = new Date();
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

    const submodulePath = join(cwd, config.path);
    try {
      // heartbeat.md is gitignored at worktree creation time, so it's
      // never tracked — no cleanup needed before merge.

      await pi.exec("git", ["merge", session.branch, "--no-edit"], {
        cwd: submodulePath,
      });
      await pi.exec("git", ["worktree", "remove", session.worktreePath], {
        cwd,
      });
      await pi.exec("git", ["branch", "-d", session.branch], { cwd });
      return { ok: true, message: `Merged ${session.branch} into ${config.path}` };
    } catch (e) {
      return {
        ok: false,
        message: `Failed to merge ${session.branch}: ${e instanceof Error ? e.message : String(e)}`,
      };
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

  async function spawnManager(configs: SubmoduleConfig[]): Promise<void> {
    const mgrDir = managerDirPath();
    await mkdir(mgrDir, { recursive: true });

    // Write heartbeat.md for the manager
    await writeFile(
      join(mgrDir, "heartbeat.md"),
      buildManagerHeartbeatMd(),
      "utf-8",
    );

    // Build and send prompt
    const prompt = buildManagerPrompt(configs, getSessionEntries(), cwd);
    pi.exec("pi", ["-p", prompt], {
      cwd: mgrDir,
      background: true,
    });

    managerSpawned = true;
    managerSpawnedAt = new Date();
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    lastCtx = ctx;
    await restoreState();

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
        pi.sendMessage(
          {
            customType: "harness-restored",
            content: `Submodule harness restored with ${configs.length} submodule(s). Manager ${managerSpawned ? "is running" : "needs recovery"}.`,
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

    // Read manager status (with cache)
    const now = Date.now();
    let status: ManagerStatusFile | null;
    if (cachedManagerStatus && now - cachedManagerStatus.at < CACHE_TTL_MS) {
      status = cachedManagerStatus.data;
    } else {
      status = await readManagerStatus(cwd);
      cachedManagerStatus = { data: status, at: now };
    }

    if (!status) {
      if (managerSpawned) {
        ctx.ui.setStatus("harness", "harness: manager stale");
      }
      return;
    }

    // Check liveness
    const age = now - new Date(status.updatedAt).getTime();
    if (age > MANAGER_STALE_THRESHOLD_MS) {
      ctx.ui.setStatus("harness", "harness: manager stale");
      return;
    }

    // Update status bar
    const totalGoals = Object.values(status.submodules).reduce(
      (sum, s) => sum + s.total,
      0,
    );
    const doneGoals = Object.values(status.submodules).reduce(
      (sum, s) => sum + s.completed,
      0,
    );

    // Check for unanswered questions (with cache)
    let questionSuffix = "";
    try {
      let configs: SubmoduleConfig[];
      if (cachedGoalConfigs && now - cachedGoalConfigs.at < CACHE_TTL_MS) {
        configs = cachedGoalConfigs.data;
      } else {
        configs = await readGoalFiles();
        cachedGoalConfigs = { data: configs, at: now };
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
        // Surface question messages
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
            await deleteMessage(cwd, "parent", filename);
          }
        }
      }
    } catch {
      // ignore
    }

    ctx.ui.setStatus(
      "harness",
      `harness: ${doneGoals}/${totalGoals} goals, ${status.status}${questionSuffix}${inboxSuffix}`,
    );

    // Check terminal states
    if (status.status === "all_complete" || status.status === "stopped") {
      loopActive = false;
      await persistState();
      ctx.ui.setStatus(
        "harness",
        `harness: ${status.status === "all_complete" ? "done" : "stopped"}`,
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
      const queue = await readQueue(cwd);
      const id = generateMessageId();
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
            text: `Queued "${params.topic}" (id: ${id}, ${queue.items.length} item(s) in queue)`,
          },
        ],
        details: { id, queueLength: queue.items.length },
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

  // --- Commands ---

  pi.registerCommand("harness:launch", {
    description:
      "Read .pi-agent/*.md goals, create worktrees, spawn workers + manager",
    handler: async (_args, ctx) => {
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

      // Create worktrees and spawn worker sessions
      const launched: string[] = [];
      for (const config of configs) {
        const incompleteGoals = config.goals.filter((g) => !g.completed);
        if (incompleteGoals.length === 0) continue;

        const session = await createWorktree(config);
        spawnSession(session, config);
        launched.push(`${config.name} (${incompleteGoals.length} goals)`);
      }

      if (launched.length === 0) {
        ctx.ui.notify("All goals are already complete!", "info");
        return;
      }

      // Create mailbox directories for each worker
      for (const config of configs) {
        await mkdir(mailboxPath(cwd, config.name), { recursive: true });
      }
      await mkdir(mailboxPath(cwd, "parent"), { recursive: true });
      await mkdir(mailboxPath(cwd, "manager"), { recursive: true });

      // Initialize worker registry
      const registryWorkers: Record<string, WorkerRegistryEntry> = {};
      for (const config of configs) {
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
      pi.sendMessage(
        {
          customType: "harness-started",
          content: [
            `## Harness Started`,
            "",
            `Spawned ${launched.length} worker session(s):`,
            ...launched.map((l) => `- ${l}`),
            "",
            "Manager session spawned to monitor progress.",
          ].join("\n"),
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
          content: `${summary}\n${statusLine}${questionAlert}`,
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

      loopActive = false;
      invalidateCache();
      await persistState();
      ctx.ui.setStatus("harness", undefined);
      ctx.ui.notify(
        "Harness stopped — stop signal written for manager",
        "info",
      );
    },
  });

  pi.registerCommand("harness:init", {
    description: "Discover git submodules and scaffold .pi-agent/ goal files",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      let stdout: string;
      try {
        const result = await pi.exec("git", ["submodule", "status"], { cwd });
        stdout = result.stdout ?? "";
      } catch {
        ctx.ui.notify("Failed to run git submodule status", "error");
        return;
      }

      const submodules: Array<{ name: string; path: string }> = [];
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        // Format: " <hash> <path> (<describe>)" or "-<hash> <path>"
        const match = line.trim().match(/^[-+ ]?[0-9a-f]+\s+(\S+)/);
        if (match) {
          const subPath = match[1];
          const name = subPath.split("/").pop() || subPath;
          submodules.push({ name, path: subPath });
        }
      }

      if (submodules.length === 0) {
        ctx.ui.notify("No submodules found in this repository", "info");
        return;
      }

      await mkdir(piAgentDir(), { recursive: true });

      const created: string[] = [];
      for (const sub of submodules) {
        const goalFile = join(piAgentDir(), `${sub.name}.md`);
        try {
          await readFile(goalFile, "utf-8");
          // File exists, skip
        } catch {
          const content = serializeGoalFile({
            name: sub.name,
            path: sub.path,
            role: "developer",
            goals: [
              { text: "Define goals for this submodule", completed: false },
            ],
            questions: [],
            context: "Add context for the agent working on this submodule.",
            rawContent: "",
          });
          await writeFile(goalFile, content, "utf-8");
          created.push(sub.name);
        }
      }

      pi.sendMessage(
        {
          customType: "harness-init",
          content: [
            `## Harness Init`,
            "",
            `Found ${submodules.length} submodule(s).`,
            created.length > 0
              ? `Created goal files for: ${created.join(", ")}`
              : "All goal files already exist.",
            "",
            "Edit the `.pi-agent/<name>.md` files to set goals, then run `/harness:launch`.",
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
    description: "Respawn a stale or dead manager session",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;
      lastCtx = ctx;

      if (!loopActive) {
        ctx.ui.notify("No active harness to recover", "warning");
        return;
      }

      const configs = await readGoalFiles();
      if (configs.length === 0) {
        ctx.ui.notify("No goal files found in .pi-agent/", "warning");
        return;
      }

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
      ctx.ui.notify("Manager respawned", "info");
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

      const queue = await readQueue(cwd);
      const id = generateMessageId();
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
            `Queue now has ${queue.items.length} item(s).`,
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
}
