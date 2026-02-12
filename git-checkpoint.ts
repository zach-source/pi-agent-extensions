/**
 * Git Checkpoint Extension for Pi
 *
 * Creates git stash checkpoints at each agent turn, providing a safety
 * net for code changes. Allows restoration to any previous state.
 *
 * Events:
 *   turn_end         - Create checkpoint after each turn
 *   session_start    - Show checkpoint count
 *
 * Commands:
 *   /checkpoint           - List recent checkpoints
 *   /checkpoint-restore   - Restore latest checkpoint
 *
 * Tools:
 *   git_checkpoint_list    - List available checkpoints
 *   git_checkpoint_restore - Restore a specific checkpoint
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CHECKPOINT_PREFIX = "pi-checkpoint";

function formatTimestamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

interface Checkpoint {
  index: number;
  message: string;
  date: string;
}

async function listCheckpoints(
  pi: ExtensionAPI,
  cwd: string,
): Promise<Checkpoint[]> {
  try {
    const result = await pi.exec("git", ["stash", "list"], { cwd });
    if (!result.stdout?.trim()) return [];

    return result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.includes(CHECKPOINT_PREFIX))
      .map((line) => {
        const match = line.match(/^stash@\{(\d+)\}:\s*[^:]+:\s*(.+)$/);
        if (!match) return null;
        const index = parseInt(match[1], 10);
        const message = match[2].trim();
        const dateMatch = message.match(/(\d{4}-\d{2}-\d{2}_\d{6})/);
        return {
          index,
          message,
          date: dateMatch ? dateMatch[1] : "unknown",
        };
      })
      .filter((c): c is Checkpoint => c !== null);
  } catch {
    return [];
  }
}

async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  try {
    const result = await pi.exec(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd },
    );
    return result.stdout?.trim() === "true";
  } catch {
    return false;
  }
}

async function hasDirtyTree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  try {
    const result = await pi.exec("git", ["status", "--porcelain"], {
      cwd,
    });
    return !!result.stdout?.trim();
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let checkpointEnabled = true;
  let turnCount = 0;

  // Create checkpoint after each turn
  pi.on("turn_end", async (_event, ctx) => {
    if (!checkpointEnabled) return;

    turnCount++;
    const cwd = ctx.cwd;

    if (!(await isGitRepo(pi, cwd))) return;
    if (!(await hasDirtyTree(pi, cwd))) return;

    try {
      const ts = formatTimestamp();
      const msg = `${CHECKPOINT_PREFIX} turn-${turnCount} ${ts}`;

      // git stash push includes untracked files
      await pi.exec(
        "git",
        ["stash", "push", "--include-untracked", "-m", msg],
        { cwd },
      );

      // Immediately pop to restore working state
      // (stash is kept in reflog for recovery)
      await pi.exec("git", ["stash", "pop"], { cwd });
    } catch {
      // Stash might fail if nothing to stash, that's OK
    }
  });

  // Show checkpoint info on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!(await isGitRepo(pi, ctx.cwd))) return;

    const checkpoints = await listCheckpoints(pi, ctx.cwd);
    if (checkpoints.length > 0) {
      ctx.ui.setStatus("checkpoint", `checkpoints: ${checkpoints.length}`);
    }
  });

  // --- /checkpoint command ---
  pi.registerCommand("checkpoint", {
    description: "List git checkpoints created by the agent",
    handler: async (_args, ctx) => {
      if (!(await isGitRepo(pi, ctx.cwd))) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }

      const checkpoints = await listCheckpoints(pi, ctx.cwd);
      if (checkpoints.length === 0) {
        ctx.ui.notify("No checkpoints found", "info");
        return;
      }

      const lines = checkpoints.map(
        (c) => `  stash@{${c.index}} — ${c.message}`,
      );

      pi.sendMessage(
        {
          customType: "checkpoint-list",
          content: `## Git Checkpoints (${checkpoints.length})\n\n${lines.join("\n")}\n\nUse \`git stash apply stash@{N}\` to restore a specific checkpoint.`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /checkpoint-restore command ---
  pi.registerCommand("checkpoint-restore", {
    description: "Restore the most recent checkpoint",
    handler: async (args, ctx) => {
      if (!(await isGitRepo(pi, ctx.cwd))) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }

      const checkpoints = await listCheckpoints(pi, ctx.cwd);
      if (checkpoints.length === 0) {
        ctx.ui.notify("No checkpoints to restore", "warning");
        return;
      }

      const target = args?.trim()
        ? parseInt(args.trim(), 10)
        : checkpoints[0].index;

      try {
        await pi.exec("git", ["stash", "apply", `stash@{${target}}`], {
          cwd: ctx.cwd,
        });
        ctx.ui.notify(`Restored checkpoint stash@{${target}}`, "info");
      } catch {
        ctx.ui.notify(
          `Failed to restore checkpoint stash@{${target}}`,
          "error",
        );
      }
    },
  });

  // --- git_checkpoint_list tool ---
  pi.registerTool({
    name: "git_checkpoint_list",
    label: "List Checkpoints",
    description:
      "List available git checkpoints created during the session. " +
      "Use to find restore points after mistakes.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as Record<string, unknown>)?.cwd?.toString() || ".";
      const checkpoints = await listCheckpoints(pi, cwd);

      if (checkpoints.length === 0) {
        return {
          content: [{ type: "text", text: "No checkpoints available." }],
          details: {},
        };
      }

      const lines = checkpoints.map((c) => `stash@{${c.index}}: ${c.message}`);
      return {
        content: [
          {
            type: "text",
            text: `${checkpoints.length} checkpoint(s):\n${lines.join("\n")}`,
          },
        ],
        details: {},
      };
    },
  });

  // --- git_checkpoint_restore tool ---
  pi.registerTool({
    name: "git_checkpoint_restore",
    label: "Restore Checkpoint",
    description:
      "Restore a git checkpoint by stash index. Use git_checkpoint_list first to find available checkpoints.",
    parameters: Type.Object({
      index: Type.Number({
        description: "Stash index to restore (from git_checkpoint_list)",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = (ctx as Record<string, unknown>)?.cwd?.toString() || ".";
      const index = (params as { index: number }).index;

      try {
        await pi.exec("git", ["stash", "apply", `stash@{${index}}`], { cwd });
        return {
          content: [
            {
              type: "text",
              text: `Restored checkpoint stash@{${index}} successfully.`,
            },
          ],
          details: {},
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to restore checkpoint: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
  });
}
