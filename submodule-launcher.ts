/**
 * Submodule Launcher Extension for Pi
 *
 * Orchestrates parallel work across git submodules using git worktrees
 * for isolation. Each submodule session runs in its own worktree, driven
 * by goal files in `.pi-agent/`. A dedicated manager session monitors
 * worker progress, writes status to `.manager-status.json`, and auto-merges
 * completed branches. The parent session reads status passively.
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
 *   /harness:add       - Create a standalone worktree task
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
import { readFile, writeFile, readdir, mkdir, rm } from "fs/promises";
import { join, resolve } from "path";

// --- Types ---

export interface SubmoduleGoal {
  text: string;
  completed: boolean;
}

export interface SubmoduleConfig {
  name: string;
  path: string;
  goals: SubmoduleGoal[];
  context: string;
  rawContent: string;
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

  return { name, path, goals, context, rawContent: content };
}

export function serializeGoalFile(config: SubmoduleConfig): string {
  const lines: string[] = [];
  lines.push(`# ${config.name}`);
  lines.push(`path: ${config.path}`);
  lines.push("");
  lines.push("## Goals");
  for (const goal of config.goals) {
    const check = goal.completed ? "x" : " ";
    lines.push(`- [${check}] ${goal.text}`);
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
    lines.push(`### ${config.name} (${status}, ${pct}%)`);

    for (const goal of config.goals) {
      const check = goal.completed ? "x" : " ";
      lines.push(`- [${check}] ${goal.text}`);
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
    goalSections.push(
      [
        `### ${config.name}`,
        `Path: ${config.path}`,
        branchInfo,
        "",
        goalList,
      ].join("\n"),
    );
  }

  const piAgentPath = resolve(baseCwd, PI_AGENT_DIR);
  const statusFilePath = resolve(baseCwd, MANAGER_STATUS_FILE);
  const stopSignalPath = resolve(baseCwd, STOP_SIGNAL_FILE);

  return [
    "You are the Launch Manager for a multi-submodule development orchestration.",
    "",
    "## Your Job",
    "Monitor worker sessions across submodules, track their progress, and auto-merge completed branches.",
    "",
    "## Current Submodules",
    ...goalSections,
    "",
    "## Instructions",
    "Every heartbeat cycle:",
    `1. Read each *.md goal file from \`${piAgentPath}\``,
    "2. Count completed vs total goals for each submodule",
    `3. Write status to \`${statusFilePath}\` as JSON:`,
    "   ```json",
    "   {",
    '     "status": "running|stalled|all_complete|stopped|error",',
    '     "updatedAt": "<ISO timestamp>",',
    '     "submodules": { "<name>": { "completed": N, "total": N, "allDone": bool } },',
    '     "stallCount": N,',
    '     "message": "<human-readable status>"',
    "   }",
    "   ```",
    `4. Check for \`${stopSignalPath}\` — if present, write final status with status: "stopped" and exit`,
    '5. If all goals are complete across all submodules, set status to "all_complete", auto-merge branches, and exit',
    "6. Track progress: if no goals change between cycles, increment stallCount",
    `7. If stallCount reaches ${MAX_STALLS}, set status to "stalled" and exit`,
    "",
    "## Auto-Merge",
    "When all goals for a submodule are complete, merge its worktree branch back:",
    `- Run \`git merge <branch> --no-edit\` from the submodule's path under \`${baseCwd}\``,
    `- Run \`git worktree remove <worktree-path>\` from \`${baseCwd}\``,
    `- Run \`git branch -d <branch>\` from \`${baseCwd}\``,
    "- Record results in the mergeResults array of the status file",
    "",
    "## Important",
    "- Always write the status file after each check, even if nothing changed",
    "- Use the updatedAt timestamp so the parent can detect liveness",
    "- Exit gracefully when stop signal is found, all goals are complete, or stall limit is reached",
  ].join("\n");
}

export async function readManagerStatus(
  baseCwd: string,
): Promise<ManagerStatusFile | null> {
  try {
    const content = await readFile(join(baseCwd, MANAGER_STATUS_FILE), "utf-8");
    return JSON.parse(content) as ManagerStatusFile;
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
});

type AddTaskInput = Static<typeof AddTaskParams>;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let cwd = "";
  let loopActive = false;
  let sessions: Map<string, SubmoduleSession> = new Map();
  let managerSpawned = false;
  let managerSpawnedAt: Date | null = null;

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
      await writeFile(
        statePath(),
        JSON.stringify(state, null, 2) + "\n",
        "utf-8",
      );
    } catch {
      // Silently fail
    }
  }

  async function restoreState(): Promise<void> {
    try {
      const content = await readFile(statePath(), "utf-8");
      const state: LaunchState = JSON.parse(content);
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
      // No saved state
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

    // Write heartbeat.md into the worktree
    const heartbeatContent = buildHeartbeatMd(config);
    try {
      await writeFile(join(wtPath, "heartbeat.md"), heartbeatContent, "utf-8");
    } catch {
      // Worktree path might not exist yet
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
    const goalList = config.goals
      .filter((g) => !g.completed)
      .map((g) => `- ${g.text}`)
      .join("\n");

    const prompt = [
      `You are working on the "${config.name}" submodule.`,
      "",
      "## Goals",
      goalList,
      "",
      config.context ? `## Context\n${config.context}\n` : "",
      "## Instructions",
      "- Work through the goals in order",
      "- Commit incrementally after each meaningful change",
      "- Update heartbeat.md as you complete tasks",
      `- You are working in a git worktree on branch \`${session.branch}\``,
      "- Do not switch branches",
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
  ): Promise<string> {
    const submodulePath = join(cwd, config.path);
    try {
      await pi.exec("git", ["merge", session.branch, "--no-edit"], {
        cwd: submodulePath,
      });
      await pi.exec("git", ["worktree", "remove", session.worktreePath], {
        cwd,
      });
      await pi.exec("git", ["branch", "-d", session.branch], { cwd });
      return `Merged ${session.branch} into ${config.path}`;
    } catch (e) {
      return `Failed to merge ${session.branch}: ${e instanceof Error ? e.message : String(e)}`;
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
    await restoreState();

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

    // Check context usage
    try {
      const usage = ctx.getContextUsage();
      if (usage && usage.percent >= CONTEXT_CRITICAL_PERCENT) {
        loopActive = false;
        await persistState();
        ctx.ui.setStatus("harness", "harness: context-full");
        return;
      }
    } catch {
      // getContextUsage may not be available
    }

    // Read manager status
    const status = await readManagerStatus(cwd);

    if (!status) {
      if (managerSpawned) {
        ctx.ui.setStatus("harness", "harness: manager stale");
      }
      return;
    }

    // Check liveness
    const age = Date.now() - new Date(status.updatedAt).getTime();
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
    ctx.ui.setStatus(
      "harness",
      `harness: ${doneGoals}/${totalGoals} goals, ${status.status}`,
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

      return {
        content: [{ type: "text", text: summary }],
        details: {
          submodules: configs.length,
          totalGoals,
          completedGoals: totalDone,
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
          const goal = config.goals.find(
            (g) =>
              g.text.toLowerCase().includes(params.goal.toLowerCase()) ||
              params.goal.toLowerCase().includes(g.text.toLowerCase()),
          );
          if (!goal) {
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
          goal.completed = true;
          break;
        }
        case "remove": {
          const idx = config.goals.findIndex(
            (g) =>
              g.text.toLowerCase().includes(params.goal.toLowerCase()) ||
              params.goal.toLowerCase().includes(g.text.toLowerCase()),
          );
          if (idx === -1) {
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
          config.goals.splice(idx, 1);
          break;
        }
      }

      // Write back
      const serialized = serializeGoalFile(config);
      const filename = config.name.toLowerCase().replace(/\s+/g, "-") + ".md";
      try {
        await writeFile(join(piAgentDir(), filename), serialized, "utf-8");
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

      const goalFile = join(piAgentDir(), `${name}.md`);
      try {
        await readFile(goalFile, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `Task "${name}" already exists at .pi-agent/${name}.md. Use harness_update_goal to modify it.`,
            },
          ],
          details: {},
        };
      } catch {
        // File doesn't exist — proceed
      }

      const config: SubmoduleConfig = {
        name,
        path: params.path ?? ".",
        goals: params.goals.map((g) => ({ text: g, completed: false })),
        context: params.context ?? "",
        rawContent: "",
      };

      const content = serializeGoalFile(config);
      try {
        await mkdir(piAgentDir(), { recursive: true });
        await writeFile(goalFile, content, "utf-8");
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

  // --- Commands ---

  pi.registerCommand("harness:launch", {
    description:
      "Read .pi-agent/*.md goals, create worktrees, spawn workers + manager",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;

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

      // Spawn the manager session
      await spawnManager(configs);

      loopActive = true;
      await persistState();

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

      pi.sendMessage(
        {
          customType: "harness-status",
          content: `${summary}\n${statusLine}`,
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
      } catch {
        // Best effort
      }

      loopActive = false;
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
            goals: [
              { text: "Define goals for this submodule", completed: false },
            ],
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
      sessions.delete(name);
      await persistState();

      pi.sendMessage(
        {
          customType: "harness-merge-result",
          content: result,
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
      const trimmed = (args ?? "").trim();

      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /harness:add <name> [goal1, goal2, ...]",
          "warning",
        );
        return;
      }

      // First token is the name, rest are goals (comma-separated or single string)
      const spaceIdx = trimmed.indexOf(" ");
      const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const goalsRaw = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
        ctx.ui.notify(
          `Invalid task name "${name}". Use kebab-case (e.g., "refactor-auth").`,
          "warning",
        );
        return;
      }

      const goalFile = join(piAgentDir(), `${name}.md`);
      try {
        await readFile(goalFile, "utf-8");
        ctx.ui.notify(
          `Task "${name}" already exists at .pi-agent/${name}.md`,
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
        goals,
        context: "",
        rawContent: "",
      };

      const content = serializeGoalFile(config);
      try {
        await mkdir(piAgentDir(), { recursive: true });
        await writeFile(goalFile, content, "utf-8");
      } catch (e) {
        ctx.ui.notify(
          `Error writing goal file: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
        return;
      }

      pi.sendMessage(
        {
          customType: "harness-add",
          content: [
            `## Task Added: ${name}`,
            "",
            `Created \`.pi-agent/${name}.md\` with ${goals.length} goal(s):`,
            ...goals.map((g) => `- [ ] ${g.text}`),
            "",
            "Run `/harness:launch` to start workers.",
          ].join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
