/**
 * Heartbeat Extension for Pi
 *
 * Reads `heartbeat.md` from the repo root on a configurable interval,
 * parses pending tasks, and wakes the agent to perform them when idle.
 * Monitors context window usage and warns at 75%/90% thresholds.
 *
 * Tools:
 *   heartbeat_complete     - Mark a task done and append a log entry
 *   heartbeat_new_session  - Spawn a new session for a complex task
 *   heartbeat_context      - Check context window usage (tokens/percent/remaining)
 *
 * Commands:
 *   /heartbeat         - Manual trigger (immediate check)
 *   /heartbeat-context - Show current context window usage
 *   /heartbeat-status  - Show interval, next check, pending tasks
 *   /heartbeat-toggle  - Enable/disable the timer
 *   /heartbeat-handoff - Start a fresh session (preserves heartbeat tasks)
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { join } from "path";

// --- Types ---

export interface HeartbeatConfig {
  intervalMs: number;
  logDays: number;
}

export interface HeartbeatTask {
  raw: string;
  description: string;
  details: string;
  completed: boolean;
  completedInfo?: string;
}

export interface ParsedHeartbeat {
  config: HeartbeatConfig;
  tasks: HeartbeatTask[];
  rawContent: string;
}

// --- Parsing ---

export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_LOG_DAYS = 7;
export const CONTEXT_WARN_PERCENT = 75;
export const CONTEXT_CRITICAL_PERCENT = 90;
export const MAX_HEARTBEAT_LINES = 200;

// --- Soul: defines what the heartbeat agent does when idle ---

export const HEARTBEAT_SOUL = `## Heartbeat Soul — Autonomous Work Principles

You are a persistent work loop. Your purpose is to make continuous,
meaningful progress on the project — whether tasks are queued or not.

### When tasks exist
Work through them in priority order. Mark done. Store learnings.

### When no tasks remain
Do NOT go idle. Examine the project and find the most valuable work:

**1. Root-cause analysis**
Review recently completed tasks and any known issues. Is there a symptom
that was fixed but whose root cause was never identified? Investigate the
underlying system, trace the failure path, and document the root cause.
If fixing it is safe and scoped, do it. Otherwise, add a new heartbeat
task describing the fix needed.

**2. Test coverage & release readiness**
Read the project plan, recent commits, and CI status. Ask:
- Are there new code paths without test coverage?
- Are there integration or end-to-end scenarios that were verified
  manually but have no automated test?
- Is there a release checklist with unchecked items?
- Are there flaky or skipped tests that should be fixed?
Add missing tests or unblock the release path. Add heartbeat tasks
for anything too large to finish in one pass.

**3. Performance & quality**
Scan for opportunities the current sprint didn't prioritize:
- N+1 queries, missing indexes, unoptimized hot paths
- Error handling gaps (silent failures, swallowed errors, missing retries)
- Security hygiene (hardcoded values, overly broad permissions, missing validation)
- Dead code, unused dependencies, stale configuration
Implement small safe improvements directly. Add heartbeat tasks for larger ones.

**4. Knowledge capture**
Use \`graphiti_add\` to persist anything the next session would benefit from:
- Architecture decisions and their rationale
- Debugging paths that worked (or didn't)
- Environment/infra quirks discovered during work
- Patterns and conventions unique to this project

**5. Groom the backlog**
Read heartbeat.md with fresh eyes:
- Remove completed tasks that are fully landed
- Break vague tasks into concrete, actionable items
- Reprioritize based on what you've learned
- Add tasks discovered during the above analysis

### Operating principles
- Bias toward action over analysis — ship small improvements continuously
- Never change behavior without tests proving correctness
- Commit working code incrementally (don't batch large changes)
- When stuck after 3 attempts, add a heartbeat task describing the blocker and move on
- Use \`heartbeat_new_session\` for work that needs a clean context window`;

export function parseInterval(value: string): number {
  const match = value.trim().match(/^(\d+)\s*(s|m|h)$/i);
  if (!match) return DEFAULT_INTERVAL_MS;
  const num = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case "s":
      return num * 1000;
    case "m":
      return num * 60 * 1000;
    case "h":
      return num * 60 * 60 * 1000;
    default:
      return DEFAULT_INTERVAL_MS;
  }
}

export function parseHeartbeat(content: string): ParsedHeartbeat {
  const config: HeartbeatConfig = {
    intervalMs: DEFAULT_INTERVAL_MS,
    logDays: DEFAULT_LOG_DAYS,
  };
  const tasks: HeartbeatTask[] = [];

  // Parse config section
  const intervalMatch = content.match(/^interval:\s*(.+)$/m);
  if (intervalMatch) {
    config.intervalMs = parseInterval(intervalMatch[1]);
  }

  const logDaysMatch = content.match(/^log_days:\s*(\d+)$/m);
  if (logDaysMatch) {
    config.logDays = Math.max(1, parseInt(logDaysMatch[1], 10));
  }

  // Parse tasks line-by-line to capture multi-line details
  const taskLineRegex = /^- \[([ xX])\] (.+)$/;
  const lines = content.split("\n");
  let currentTask: HeartbeatTask | null = null;
  let detailLines: string[] = [];

  function finishTask() {
    if (!currentTask) return;
    // Trim trailing blank lines from details
    while (
      detailLines.length > 0 &&
      detailLines[detailLines.length - 1].trim() === ""
    ) {
      detailLines.pop();
    }
    currentTask.details = detailLines.join("\n");
    tasks.push(currentTask);
    currentTask = null;
    detailLines = [];
  }

  for (const line of lines) {
    const taskMatch = line.match(taskLineRegex);
    if (taskMatch) {
      finishTask();

      const completed = taskMatch[1].toLowerCase() === "x";
      const raw = line;
      const desc = taskMatch[2].trim();
      const infoMatch = desc.match(/\(completed .+\)$/);

      currentTask = {
        raw,
        description: infoMatch
          ? desc.slice(0, -infoMatch[0].length).trim()
          : desc,
        details: "",
        completed,
        completedInfo: infoMatch ? infoMatch[0] : undefined,
      };
    } else if (
      currentTask &&
      (line.startsWith("  ") || line.startsWith("\t") || line.trim() === "")
    ) {
      // Indented or blank continuation line belongs to current task
      detailLines.push(line);
    } else {
      // Non-continuation line (section header, config, etc.)
      finishTask();
    }
  }

  finishTask();

  return { config, tasks, rawContent: content };
}

export function formatTimestamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// --- Daily log helpers ---

export function formatDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatTimeStr(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function logDir(baseCwd: string): string {
  return join(baseCwd, ".heartbeat", "logs");
}

function logFilePath(baseCwd: string, date: Date): string {
  return join(logDir(baseCwd), `${formatDateStr(date)}.md`);
}

async function appendLogEntry(
  baseCwd: string,
  taskDescription: string,
  summary: string,
): Promise<void> {
  const now = new Date();
  const dir = logDir(baseCwd);
  await mkdir(dir, { recursive: true });

  const filePath = logFilePath(baseCwd, now);
  const timeStr = formatTimeStr(now);
  const entry = `### ${timeStr}\n- ${summary}\n  Task: ${taskDescription}\n\n`;

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet — create with header
    existing = `# Heartbeat Log — ${formatDateStr(now)}\n\n`;
  }

  await writeFile(filePath, existing + entry, "utf-8");
}

async function pruneOldLogs(baseCwd: string, logDays: number): Promise<void> {
  const dir = logDir(baseCwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return; // Directory doesn't exist yet
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - logDays);
  cutoff.setHours(0, 0, 0, 0);

  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;

    const fileDate = new Date(match[1] + "T00:00:00");
    if (isNaN(fileDate.getTime())) continue;

    if (fileDate < cutoff) {
      try {
        await unlink(join(dir, file));
      } catch {
        // Ignore deletion errors
      }
    }
  }
}

async function getLogStats(
  baseCwd: string,
): Promise<{ count: number; oldest?: string; newest?: string } | null> {
  const dir = logDir(baseCwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const dates = files
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.md$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1])
    .sort();

  if (dates.length === 0) return { count: 0 };
  return {
    count: dates.length,
    oldest: dates[0],
    newest: dates[dates.length - 1],
  };
}

// --- Compaction preamble ---

export function buildCompactionPreamble(
  pending: HeartbeatTask[],
  completed: HeartbeatTask[],
): string {
  const lines = [
    "## Heartbeat Context (preserve across compaction)",
    "",
    "You are operating under the heartbeat extension. On each heartbeat interval,",
    "you receive pending tasks from `heartbeat.md` and work through them autonomously.",
    "",
    "### Active task list",
    ...pending.map((t) => `- [ ] ${t.description}`),
    "",
    `### Completed this session: ${completed.length}`,
    "",
    "### Standing instructions",
    "- After completing a task, use `heartbeat_complete` to mark it done in heartbeat.md",
    "- Use `graphiti_add` to store significant findings, solutions, or context for future sessions",
    "- Groom heartbeat.md: add new tasks discovered during work, remove stale ones, reprioritize as needed",
    "- For complex tasks that need isolation, use `heartbeat_new_session` to spawn a dedicated session",
    "- Re-read heartbeat.md before starting the next task (it may have been updated externally)",
  ];
  return lines.join("\n");
}

// --- Tool schemas ---

const CompleteParams = Type.Object({
  task: Type.String({
    description:
      "The task description to mark as complete (must match a pending task in heartbeat.md)",
  }),
  summary: Type.String({
    description: "Brief summary of what was done to complete this task",
  }),
});

type CompleteInput = Static<typeof CompleteParams>;

const NewSessionParams = Type.Object({
  task: Type.String({
    description: "The task to perform in the new session",
  }),
  prompt: Type.String({
    description:
      "The full prompt/instructions for the new session. Include all necessary context since the new session starts fresh.",
  }),
});

type NewSessionInput = Static<typeof NewSessionParams>;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let pendingWakeup = false;
  let enabled = true;
  let lastCheck: Date | null = null;
  let lastError: string | null = null;
  let cwd = "";
  let sessionCompletedCount = 0;
  let lastWarningPercent = 0;
  let idlePromptSent = false;

  // --- Helpers ---

  function heartbeatPath(): string {
    return join(cwd, "heartbeat.md");
  }

  async function readHeartbeatFile(): Promise<ParsedHeartbeat | null> {
    try {
      const content = await readFile(heartbeatPath(), "utf-8");
      return parseHeartbeat(content);
    } catch {
      return null;
    }
  }

  function pendingTasks(parsed: ParsedHeartbeat): HeartbeatTask[] {
    return parsed.tasks.filter((t) => !t.completed);
  }

  function completedTasks(parsed: ParsedHeartbeat): HeartbeatTask[] {
    return parsed.tasks.filter((t) => t.completed);
  }

  function buildTaskMessage(tasks: HeartbeatTask[]): string {
    const taskLines: string[] = [];
    for (const t of tasks) {
      taskLines.push(`- ${t.description}`);
      if (t.details) {
        taskLines.push(t.details);
      }
    }

    const lines = [
      "## Heartbeat: Pending Tasks",
      "",
      "The following tasks from `heartbeat.md` need attention:",
      "",
      ...taskLines,
      "",
      "### Instructions",
      "",
      "1. **Work through tasks** in priority order (top = highest priority).",
      "2. **Mark done**: After completing each task, call `heartbeat_complete` with a summary.",
      "3. **Store learnings**: Use `graphiti_add` to persist any significant discoveries,",
      "   solutions, patterns, or context that would help future sessions. Include:",
      "   - What you tried and what worked",
      "   - Key file paths, configurations, or commands",
      "   - Architectural decisions and their rationale",
      "4. **Groom the task list**: As you work, update `heartbeat.md` directly:",
      "   - Add new `- [ ]` tasks you discover that need doing",
      "   - Remove or mark tasks that are no longer relevant",
      "   - Reorder tasks if priorities shift based on what you learn",
      "   - Break large tasks into smaller, actionable subtasks",
      "5. **New sessions**: For complex or risky tasks that benefit from isolation",
      "   (e.g., large refactors, exploratory work), use `heartbeat_new_session`",
      "   to spawn a fresh session with a focused prompt. The current session stays clean.",
      "6. **Re-read heartbeat.md** before starting each new task — it may have",
      "   been updated externally or by a spawned session.",
    ];
    return lines.join("\n");
  }

  function buildIdlePrompt(completed: HeartbeatTask[]): string {
    const lines = [
      "## Heartbeat: No Pending Tasks",
      "",
      `Completed tasks this session: ${sessionCompletedCount}`,
      "",
    ];

    if (completed.length > 0) {
      lines.push("Recently completed in heartbeat.md:");
      for (const t of completed.slice(-5)) {
        lines.push(`- ${t.description}`);
      }
      lines.push("");
    }

    lines.push(HEARTBEAT_SOUL);
    lines.push("");
    lines.push(
      "Begin by reading the project plan and recent git history,",
      "then choose the highest-value proactive work from the priorities above.",
      "Add any new tasks you identify to `heartbeat.md`.",
    );

    return lines.join("\n");
  }

  async function doCheck(ctx: { isIdle: () => boolean }): Promise<string> {
    lastCheck = new Date();
    lastError = null;

    const parsed = await readHeartbeatFile();
    if (!parsed) {
      return "skip:no-file";
    }

    // Update interval if config changed
    if (parsed.config.intervalMs !== intervalMs) {
      intervalMs = parsed.config.intervalMs;
      restartTimer(ctx);
    }

    const pending = pendingTasks(parsed);

    if (pending.length === 0) {
      // No tasks — send idle/proactive prompt once per idle stretch
      if (idlePromptSent) {
        return "skip:idle-already-prompted";
      }

      if (!ctx.isIdle()) {
        return "skip:no-tasks";
      }

      idlePromptSent = true;
      const completed = completedTasks(parsed);
      pi.sendUserMessage(buildIdlePrompt(completed));
      return "woke:idle-proactive";
    }

    // Tasks exist — reset idle flag so we re-prompt if tasks drain again
    idlePromptSent = false;

    if (!ctx.isIdle()) {
      pendingWakeup = true;
      return "deferred:busy";
    }

    // Agent is idle, wake it up
    pendingWakeup = false;
    pi.sendUserMessage(buildTaskMessage(pending));
    return `woke:${pending.length}-tasks`;
  }

  function startTimer(ctx: { isIdle: () => boolean }) {
    stopTimer();
    if (!enabled) return;

    intervalHandle = setInterval(async () => {
      try {
        await doCheck(ctx);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }, intervalMs);
  }

  function stopTimer() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  function restartTimer(ctx: { isIdle: () => boolean }) {
    stopTimer();
    startTimer(ctx);
  }

  function updateStatus(ctx: {
    ui: { setStatus: (key: string, text: string | undefined) => void };
  }) {
    if (!enabled) {
      ctx.ui.setStatus("heartbeat", "heartbeat: off");
      return;
    }
    const interval = formatDuration(intervalMs);
    const status = lastError ? `heartbeat: err` : `heartbeat: ${interval}`;
    ctx.ui.setStatus("heartbeat", status);
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    pendingWakeup = false;
    lastError = null;
    sessionCompletedCount = 0;
    lastWarningPercent = 0;
    idlePromptSent = false;

    // Read config from heartbeat.md if it exists
    const parsed = await readHeartbeatFile();
    if (parsed) {
      intervalMs = parsed.config.intervalMs;
      // Prune old logs (fire-and-forget)
      pruneOldLogs(cwd, parsed.config.logDays).catch(() => {});

      // Warn if heartbeat.md is bloated
      const lineCount = parsed.rawContent.split("\n").length;
      if (lineCount > MAX_HEARTBEAT_LINES) {
        pi.sendMessage(
          {
            customType: "heartbeat-file-warning",
            content:
              `**heartbeat.md is ${lineCount} lines** — this wastes context on every heartbeat cycle.\n` +
              `Consider pruning completed \`[x]\` tasks and any inline \`## Log\` section ` +
              `(daily logs are already saved to \`.heartbeat/logs/\`).`,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }

    startTimer(ctx);
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (pendingWakeup && enabled && ctx.isIdle()) {
      try {
        await doCheck(ctx);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  });

  // Proactive context usage monitoring — warn at 75% and 90%
  pi.on("turn_end", async (_event, ctx) => {
    try {
      const usage = ctx.getContextUsage();
      if (!usage || usage.contextWindow === 0) return;

      const percent = usage.percent;
      let warning: string | null = null;

      if (
        percent >= CONTEXT_CRITICAL_PERCENT &&
        lastWarningPercent < CONTEXT_CRITICAL_PERCENT
      ) {
        warning =
          `⚠️ **Context window critically full (${percent.toFixed(0)}%)**\n` +
          `Using ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens.\n` +
          `Only ${(usage.contextWindow - usage.tokens).toLocaleString()} tokens remain.\n\n` +
          `**Action required:** Use \`/heartbeat-handoff\` to start a fresh session, ` +
          `or finish your current task and call \`heartbeat_complete\`.`;
        lastWarningPercent = CONTEXT_CRITICAL_PERCENT;
      } else if (
        percent >= CONTEXT_WARN_PERCENT &&
        lastWarningPercent < CONTEXT_WARN_PERCENT
      ) {
        warning =
          `⚡ **Context window ${percent.toFixed(0)}% full** — ` +
          `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens.\n` +
          `Consider wrapping up the current task soon. ` +
          `Use \`heartbeat_context\` to check exact usage or \`/heartbeat-handoff\` to start fresh.`;
        lastWarningPercent = CONTEXT_WARN_PERCENT;
      }

      if (warning) {
        pi.sendMessage(
          {
            customType: "heartbeat-context-warning",
            content: warning,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    } catch {
      // getContextUsage may not be available — ignore silently
    }
  });

  // Inject heartbeat context before compaction so the LLM retains task awareness
  pi.on("session_before_compact", async (_event, _ctx) => {
    const parsed = await readHeartbeatFile();
    if (!parsed) return;

    const pending = pendingTasks(parsed);
    if (pending.length === 0) return;

    const completed = completedTasks(parsed);
    const preamble = buildCompactionPreamble(pending, completed);

    pi.sendMessage(
      {
        customType: "heartbeat-compaction-context",
        content: preamble,
        display: false,
      },
      { triggerTurn: false },
    );
  });

  // Reset warning threshold after compaction (context shrinks significantly)
  pi.on("session_compact", async () => {
    lastWarningPercent = 0;
  });

  pi.on("session_shutdown", async () => {
    stopTimer();
  });

  // --- Tool: heartbeat_complete ---

  pi.registerTool({
    name: "heartbeat_complete",
    label: "Heartbeat Complete",
    description:
      "Mark a heartbeat task as completed in heartbeat.md. " +
      "Updates the checkbox from `- [ ]` to `- [x]` with a timestamp, " +
      "and appends a log entry with the completion summary. " +
      "After completing a task, also use `graphiti_add` to store any " +
      "significant learnings or context for future sessions.",
    parameters: CompleteParams,

    async execute(_toolCallId, params: CompleteInput) {
      const parsed = await readHeartbeatFile();
      if (!parsed) {
        return {
          content: [{ type: "text", text: "Error: heartbeat.md not found" }],
          details: {},
        };
      }

      // Find matching pending task
      const pending = pendingTasks(parsed);
      const target = pending.find(
        (t) =>
          t.description.toLowerCase().includes(params.task.toLowerCase()) ||
          params.task.toLowerCase().includes(t.description.toLowerCase()),
      );

      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `No matching pending task found for: "${params.task}"\n\nPending tasks:\n${pending.map((t) => `- ${t.description}`).join("\n")}`,
            },
          ],
          details: {},
        };
      }

      const timestamp = formatTimestamp();
      let content = parsed.rawContent;

      // Replace the task checkbox
      const completedLine = `- [x] ${target.description} (completed ${timestamp})`;
      content = content.replace(target.raw, completedLine);

      try {
        // Write log entry to daily log file instead of heartbeat.md
        await appendLogEntry(cwd, target.description, params.summary);
        await writeFile(heartbeatPath(), content, "utf-8");
        sessionCompletedCount++;

        const remaining = pending.length - 1;
        const hint =
          remaining > 0
            ? `\n\n${remaining} task(s) remaining. Re-read heartbeat.md before starting the next one.`
            : "\n\nAll tasks complete!";

        return {
          content: [
            {
              type: "text",
              text:
                `Completed: ${target.description}\nTimestamp: ${timestamp}\nSummary: ${params.summary}` +
                hint +
                "\n\nRemember: Use `graphiti_add` to store any significant findings from this task.",
            },
          ],
          details: {},
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing heartbeat.md: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // --- Tool: heartbeat_new_session ---

  pi.registerTool({
    name: "heartbeat_new_session",
    label: "Heartbeat New Session",
    description:
      "Spawn a new Pi session to handle a complex heartbeat task in isolation. " +
      "Use this for tasks that are risky, exploratory, or large enough to benefit " +
      "from a fresh context window. The new session starts clean with the given prompt. " +
      "The current session continues after spawning. The new session should update " +
      "heartbeat.md and use graphiti_add when done.",
    parameters: NewSessionParams,

    async execute(_toolCallId, params: NewSessionInput) {
      try {
        const sessionPrompt = [
          params.prompt,
          "",
          "---",
          "## Heartbeat session instructions",
          `Working directory: ${cwd}`,
          `Task: ${params.task}`,
          "",
          "When you complete this task:",
          "1. Use `heartbeat_complete` to mark it done in heartbeat.md",
          "2. Use `graphiti_add` to store any significant findings or context",
          "3. If you discover new tasks, add them as `- [ ]` entries in heartbeat.md",
        ].join("\n");

        // Use pi.exec to spawn a new pi session in the background
        pi.exec("pi", ["-p", sessionPrompt], {
          cwd,
          background: true,
        });

        return {
          content: [
            {
              type: "text",
              text: `Spawned new session for: ${params.task}\n\nThe session is running in the background. It will update heartbeat.md when complete.`,
            },
          ],
          details: {},
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error spawning session: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // --- Tool: heartbeat_context ---

  pi.registerTool({
    name: "heartbeat_context",
    label: "Heartbeat Context Usage",
    description:
      "Check current context window usage. Returns token count, context window size, " +
      "usage percentage, and remaining tokens. Use this to decide whether to wrap up " +
      "the current task or start a new session via /heartbeat-handoff.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const usage = ctx.getContextUsage();
        if (!usage || usage.contextWindow === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Context usage data not available.",
              },
            ],
            details: {},
          };
        }

        const remaining = usage.contextWindow - usage.tokens;
        const percent = usage.percent;
        const warning =
          percent >= 80
            ? `\n\n⚠️ Context is ${percent.toFixed(0)}% full — consider using /heartbeat-handoff to start a fresh session.`
            : "";

        return {
          content: [
            {
              type: "text",
              text:
                `Context usage: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${percent.toFixed(1)}%)\n` +
                `Remaining: ${remaining.toLocaleString()} tokens` +
                warning,
            },
          ],
          details: {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: Math.round(percent * 10) / 10,
            remaining,
          },
        };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "Error: unable to retrieve context usage.",
            },
          ],
          details: {},
        };
      }
    },
  });

  // --- Commands ---

  pi.registerCommand("heartbeat", {
    description: "Trigger an immediate heartbeat check",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;

      const parsed = await readHeartbeatFile();
      if (!parsed) {
        ctx.ui.notify("No heartbeat.md found in " + cwd, "warning");
        return;
      }

      const pending = pendingTasks(parsed);
      if (pending.length === 0) {
        ctx.ui.notify("No pending tasks in heartbeat.md", "info");
        return;
      }

      ctx.ui.notify(
        `Found ${pending.length} pending task(s), waking agent...`,
        "info",
      );
      pi.sendUserMessage(buildTaskMessage(pending));
    },
  });

  pi.registerCommand("heartbeat-context", {
    description: "Show current context window usage",
    handler: async (_args, ctx) => {
      try {
        const usage = ctx.getContextUsage();
        if (!usage || usage.contextWindow === 0) {
          ctx.ui.notify("Context usage data not available", "warning");
          return;
        }

        const remaining = usage.contextWindow - usage.tokens;
        const percent = usage.percent;

        let advisory: string;
        if (percent >= CONTEXT_CRITICAL_PERCENT) {
          advisory =
            "🔴 Critical — start a fresh session with `/heartbeat-handoff`";
        } else if (percent >= CONTEXT_WARN_PERCENT) {
          advisory = "🟡 High — consider wrapping up soon";
        } else if (percent >= 50) {
          advisory = "🟢 Moderate — plenty of room";
        } else {
          advisory = "🟢 Low — full capacity available";
        }

        const lines = [
          "**Context Usage**",
          `- Tokens: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()}`,
          `- Used: ${percent.toFixed(1)}%`,
          `- Remaining: ${remaining.toLocaleString()} tokens`,
          `- Status: ${advisory}`,
        ];

        pi.sendMessage(
          {
            customType: "heartbeat-context-usage",
            content: lines.join("\n"),
            display: true,
          },
          { triggerTurn: false },
        );
      } catch {
        ctx.ui.notify("Unable to retrieve context usage", "error");
      }
    },
  });

  pi.registerCommand("heartbeat-status", {
    description: "Show heartbeat status, interval, and pending tasks",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;

      const lines: string[] = [];
      lines.push(`**Heartbeat Status**`);
      lines.push(`- Enabled: ${enabled}`);
      lines.push(`- Interval: ${formatDuration(intervalMs)}`);
      lines.push(`- Timer active: ${intervalHandle !== null}`);
      lines.push(
        `- Last check: ${lastCheck ? lastCheck.toLocaleTimeString() : "never"}`,
      );
      lines.push(`- Pending wakeup: ${pendingWakeup}`);
      lines.push(`- Completed this session: ${sessionCompletedCount}`);

      if (lastError) {
        lines.push(`- Last error: ${lastError}`);
      }

      const parsed = await readHeartbeatFile();
      if (parsed) {
        const pending = pendingTasks(parsed);
        const completed = completedTasks(parsed);
        lines.push(`- File: ${heartbeatPath()}`);
        lines.push(`- Pending tasks: ${pending.length}`);
        lines.push(`- Completed tasks: ${completed.length}`);
        lines.push(`- Log dir: .heartbeat/logs/`);
        lines.push(`- Log retention: ${parsed.config.logDays} days`);

        const stats = await getLogStats(cwd);
        if (stats && stats.count > 0) {
          lines.push(
            `- Log files: ${stats.count} (${stats.oldest} → ${stats.newest})`,
          );
        } else {
          lines.push(`- Log files: 0`);
        }

        if (pending.length > 0) {
          lines.push("");
          lines.push("**Pending:**");
          for (const t of pending) {
            lines.push(`  - ${t.description}`);
          }
        }
      } else {
        lines.push(`- File: not found`);
      }

      pi.sendMessage(
        {
          customType: "heartbeat-status",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("heartbeat-toggle", {
    description: "Enable or disable the heartbeat timer",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        cwd = ctx.cwd;
        startTimer(ctx);
        ctx.ui.notify("Heartbeat enabled", "info");
      } else {
        stopTimer();
        pendingWakeup = false;
        ctx.ui.notify("Heartbeat disabled", "info");
      }

      updateStatus(ctx);
    },
  });

  pi.registerCommand("heartbeat-handoff", {
    description:
      "Start a fresh session, preserving heartbeat tasks for the new context",
    handler: async (_args, ctx) => {
      const parsed = await readHeartbeatFile();
      const pendingCount = parsed ? pendingTasks(parsed).length : 0;

      ctx.ui.notify(
        `Handing off: ${sessionCompletedCount} completed, ${pendingCount} remaining. Starting fresh session...`,
        "info",
      );

      try {
        ctx.newSession();
      } catch (e) {
        ctx.ui.notify(
          `Handoff failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });
}
