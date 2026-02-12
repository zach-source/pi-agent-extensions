/**
 * Auto-Commit on Exit Extension for Pi
 *
 * Automatically commits any uncommitted changes when the session ends,
 * using the last assistant message as the commit message. Prevents
 * losing work from forgotten commits.
 *
 * Events:
 *   session_shutdown  - Auto-commit dirty working tree
 *   turn_end          - Track last assistant message for commit message
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let lastAssistantMessage = "";
  let enabled = true;

  // Track the last assistant message for use as commit message
  pi.on("turn_end", async (_event, ctx) => {
    // Store a summary of what was done
    try {
      const result = await pi.exec("git", ["log", "--oneline", "-1"], {
        cwd: ctx.cwd,
      });
      if (result.stdout) {
        lastAssistantMessage = result.stdout.trim();
      }
    } catch {
      // Not a git repo or no commits
    }
  });

  // Auto-commit on session shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!enabled) return;

    try {
      // Check if we're in a git repo with changes
      const status = await pi.exec("git", ["status", "--porcelain"], {
        cwd: ctx.cwd,
      });

      if (!status.stdout?.trim()) return; // Nothing to commit

      // Stage all tracked file changes (not untracked)
      await pi.exec("git", ["add", "-u"], { cwd: ctx.cwd });

      // Check if there's anything staged
      const staged = await pi.exec("git", ["diff", "--cached", "--stat"], {
        cwd: ctx.cwd,
      });

      if (!staged.stdout?.trim()) return;

      // Build commit message
      const message =
        lastAssistantMessage ||
        `wip: auto-commit on session exit (${new Date().toISOString().slice(0, 16)})`;

      await pi.exec("git", ["commit", "-m", `wip: ${message}`], {
        cwd: ctx.cwd,
      });

      ctx.ui.notify("Auto-committed changes on exit", "info");
    } catch {
      // Silently fail - don't block session shutdown
    }
  });

  // --- /auto-commit command ---
  pi.registerCommand("auto-commit", {
    description: "Toggle auto-commit on exit (currently: on/off)",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        `Auto-commit on exit: ${enabled ? "enabled" : "disabled"}`,
        "info",
      );
      ctx.ui.setStatus("auto-commit", enabled ? "auto-commit: on" : "");
    },
  });

  // --- auto_commit_status tool ---
  pi.registerTool({
    name: "auto_commit_status",
    label: "Auto-Commit Status",
    description:
      "Check or toggle auto-commit on exit. When enabled, uncommitted changes are automatically committed when the session ends.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: 'status', 'enable', or 'disable'",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const action = (params as { action?: string }).action || "status";

      if (action === "enable") {
        enabled = true;
      } else if (action === "disable") {
        enabled = false;
      }

      return {
        content: [
          {
            type: "text",
            text: `Auto-commit on exit is ${enabled ? "enabled" : "disabled"}.`,
          },
        ],
        details: {},
      };
    },
  });

  // Status bar indicator
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) {
      ctx.ui.setStatus("auto-commit", "auto-commit: on");
    }
  });
}
