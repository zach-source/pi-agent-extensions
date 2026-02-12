/**
 * Permission Gate Extension for Pi
 *
 * Intercepts dangerous bash commands and blocks them with a warning.
 * Protects against accidental destructive operations like rm -rf,
 * force pushes, sudo, etc.
 *
 * Events:
 *   tool_call  - Intercept bash tool calls to check for dangerous patterns
 *
 * Commands:
 *   /permission-gate  - Toggle the gate on/off
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Patterns for destructive bash commands
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // File destruction
  { pattern: /\brm\s+-[^\s]*r/i, label: "recursive delete" },
  { pattern: /\brm\s+-[^\s]*f/i, label: "force delete" },
  { pattern: /\brmdir\b/i, label: "remove directory" },
  { pattern: /\bshred\b/i, label: "secure delete" },

  // File modification
  { pattern: /\bchmod\b/i, label: "change permissions" },
  { pattern: /\bchown\b/i, label: "change ownership" },
  { pattern: /\bdd\b/i, label: "disk dump" },
  { pattern: /\btruncate\b/i, label: "truncate file" },

  // Dangerous redirects
  { pattern: />\s*\/dev\//, label: "redirect to device" },
  { pattern: /:\s*>\s*\S+/, label: "truncate via redirect" },

  // Package managers (install/uninstall)
  {
    pattern: /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
    label: "npm modification",
  },
  {
    pattern: /\byarn\s+(add|remove|install|publish)\b/i,
    label: "yarn modification",
  },
  {
    pattern: /\bpnpm\s+(add|remove|install|publish)\b/i,
    label: "pnpm modification",
  },
  {
    pattern: /\bpip\s+(install|uninstall)\b/i,
    label: "pip modification",
  },
  {
    pattern: /\bapt(-get)?\s+(install|remove|purge|update|upgrade)\b/i,
    label: "apt modification",
  },
  {
    pattern: /\bbrew\s+(install|uninstall|upgrade)\b/i,
    label: "brew modification",
  },

  // Git destructive operations
  {
    pattern: /\bgit\s+push\s+.*--force\b/i,
    label: "git force push",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    label: "git hard reset",
  },
  {
    pattern: /\bgit\s+clean\s+-[^\s]*f/i,
    label: "git clean force",
  },
  {
    pattern: /\bgit\s+branch\s+-[dD]\b/i,
    label: "git delete branch",
  },
  {
    pattern: /\bgit\s+rebase\b/i,
    label: "git rebase",
  },

  // Privilege escalation
  { pattern: /\bsudo\b/i, label: "sudo" },
  { pattern: /\bsu\s/i, label: "switch user" },

  // Process management
  { pattern: /\bkill\s+-9\b/i, label: "force kill" },
  { pattern: /\bkillall\b/i, label: "kill all" },
  { pattern: /\bpkill\b/i, label: "pattern kill" },

  // System operations
  { pattern: /\breboot\b/i, label: "reboot" },
  { pattern: /\bshutdown\b/i, label: "shutdown" },
  {
    pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
    label: "systemctl",
  },

  // Interactive editors (would hang the agent)
  { pattern: /\b(vim?|nano|emacs)\b/i, label: "interactive editor" },

  // Docker destructive
  {
    pattern: /\bdocker\s+(rm|rmi|system\s+prune)\b/i,
    label: "docker cleanup",
  },
  {
    pattern: /\bdocker-compose\s+down\b/i,
    label: "docker-compose down",
  },

  // Kubernetes destructive
  { pattern: /\bkubectl\s+delete\b/i, label: "kubectl delete" },
];

// Safe command prefixes that override destructive patterns
const SAFE_OVERRIDES: RegExp[] = [
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*cat\b/,
  /^\s*grep\b/,
  /^\s*rg\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /^\s*man\b/,
  /^\s*--help\b/,
  /--dry-run/,
];

function checkCommand(command: string): string | null {
  // Check if command starts with a known safe prefix
  for (const safe of SAFE_OVERRIDES) {
    if (safe.test(command)) return null;
  }

  // Check for destructive patterns
  for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }

  return null;
}

export { checkCommand, DESTRUCTIVE_PATTERNS, SAFE_OVERRIDES };

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let blockedCount = 0;

  // Intercept tool calls
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return;

    const toolName =
      (event as Record<string, unknown>).toolName?.toString() ?? "";
    if (toolName !== "bash") return;

    const input = (event as Record<string, unknown>).input as
      | Record<string, unknown>
      | undefined;
    const command = input?.command?.toString() ?? "";
    if (!command) return;

    const matched = checkCommand(command);
    if (matched) {
      blockedCount++;
      ctx.ui.notify(
        `Permission gate blocked: ${matched}\nCommand: ${command.slice(0, 100)}`,
        "warning",
      );
      return {
        block: true,
        reason: `Blocked by permission-gate: "${matched}". Command: ${command.slice(0, 80)}`,
      };
    }
  });

  // --- /permission-gate command ---
  pi.registerCommand("permission-gate", {
    description: "Toggle permission gate for dangerous commands",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(
        `Permission gate: ${enabled ? "enabled" : "disabled"} (${blockedCount} blocked this session)`,
        "info",
      );
      ctx.ui.setStatus("permission-gate", enabled ? "gate: on" : "gate: off");
    },
  });

  // Status bar on session start
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("permission-gate", enabled ? "gate: on" : "");
  });
}
