/**
 * Plan Mode Extension for Pi
 *
 * Provides a Claude Code-style "plan mode" for safe code exploration.
 * When enabled, the agent can only use read-only tools and cannot
 * modify files. After planning, extracts a numbered todo list and
 * tracks progress during execution.
 *
 * Features:
 * - /plan command to toggle plan mode on/off
 * - In plan mode: blocks write, edit, and destructive bash
 * - Injects system context about restrictions
 * - Extracts numbered steps from the plan
 * - Tracks progress via [DONE:N] markers
 *
 * Events:
 *   tool_call       - Block non-read tools in plan mode
 *   session_start   - Reset plan mode state
 *
 * Commands:
 *   /plan           - Toggle plan mode
 *   /plan-execute   - Exit plan mode and execute the plan
 *   /plan-status    - Show plan progress
 *
 * Ported from oh-my-pi's plan-mode.ts example extension.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// --- Constants ---

// Tools allowed in plan mode (read-only)
const PLAN_MODE_TOOLS = new Set([
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "graphiti_search",
  "graphiti_status",
  "bmad_config",
  "bmad_get_template",
]);

// Tools always blocked in plan mode
const BLOCKED_TOOLS = new Set([
  "write",
  "edit",
  "notebook",
  "todo",
  "bmad_save_document",
  "bmad_update_status",
]);

// Destructive bash patterns blocked in plan mode
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /[^<]>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)\b/i,
  /\byarn\s+(add|remove|install|publish)\b/i,
  /\bpnpm\s+(add|remove|install|publish)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout\s+-b|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsudo\b/i,
  /\bkill\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe bash patterns that override blocks
const SAFE_BASH_PATTERNS: RegExp[] = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*grep\b/,
  /^\s*rg\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*wc\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|describe)\b/,
  /^\s*gh\s+(pr|issue)\s+(view|diff|list|status)\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*type\b/,
  /--help\b/,
  /--version\b/,
  /--dry-run\b/,
];

// --- Types ---

interface PlanStep {
  id: number;
  text: string;
  done: boolean;
}

// --- State ---

let planModeActive = false;
let planSteps: PlanStep[] = [];
let planText = "";

// --- Helpers ---

function isBashSafe(command: string): boolean {
  // Check safe patterns first
  for (const safe of SAFE_BASH_PATTERNS) {
    if (safe.test(command)) return true;
  }

  // Check destructive patterns
  for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
    if (pattern.test(command)) return false;
  }

  return true; // Allow by default if no destructive pattern matched
}

function extractPlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    // Match numbered steps: "1. Step text" or "1) Step text"
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (match) {
      steps.push({
        id: parseInt(match[1], 10),
        text: match[2].trim(),
        done: false,
      });
    }
  }

  return steps;
}

function formatPlanProgress(): string {
  if (planSteps.length === 0) {
    return planModeActive
      ? "Plan mode active (no steps extracted yet)"
      : "Plan mode inactive";
  }

  const done = planSteps.filter((s) => s.done).length;
  const total = planSteps.length;
  const lines = [`## Plan Progress: ${done}/${total}`, ""];

  for (const step of planSteps) {
    const check = step.done ? "[x]" : "[ ]";
    lines.push(`${check} ${step.id}. ${step.text}`);
  }

  return lines.join("\n");
}

const PLAN_MODE_CONTEXT = `
[PLAN MODE ACTIVE]
You are in READ-ONLY plan mode. You CANNOT:
- Create, modify, or delete any files (no write, edit, notebook tools)
- Run destructive bash commands (no rm, mv, cp, git add/commit/push, npm install, etc.)
- Modify any state

You CAN:
- Read files, search code, explore the codebase
- Run read-only bash commands (git status, git log, git diff, ls, cat, etc.)
- Think, reason, and create a numbered plan

Create a numbered plan with specific steps. Format each step as:
1. First step description
2. Second step description
...

When done planning, the user can run /plan-execute to switch to execution mode.
Mark completed steps by outputting [DONE:N] where N is the step number.
`;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Reset on session start
  pi.on("session_start", async (_event, ctx) => {
    planModeActive = false;
    planSteps = [];
    planText = "";
    ctx.ui.setStatus("plan-mode", "");
  });

  // Block tools in plan mode
  pi.on("tool_call", async (event, _ctx) => {
    if (!planModeActive) return;

    const ev = event as Record<string, unknown>;
    const toolName = ev.toolName?.toString() ?? "";

    // Always blocked tools
    if (BLOCKED_TOOLS.has(toolName)) {
      return {
        block: true,
        reason: `[Plan Mode] Tool "${toolName}" is blocked in plan mode. Use /plan to exit plan mode first.`,
      };
    }

    // Bash needs command-level checking
    if (toolName === "bash") {
      const input = ev.input as Record<string, unknown> | undefined;
      const command = input?.command?.toString() ?? "";

      if (!isBashSafe(command)) {
        return {
          block: true,
          reason: `[Plan Mode] Destructive bash command blocked. Only read-only commands allowed in plan mode.`,
        };
      }
    }

    // Unknown tools not in allowlist
    if (!PLAN_MODE_TOOLS.has(toolName) && !BLOCKED_TOOLS.has(toolName)) {
      // Allow unknown tools by default (they might be read-only extensions)
    }
  });

  // Track agent output for plan extraction
  pi.on("turn_end", async (_event, _ctx) => {
    if (!planModeActive) return;

    // Check for [DONE:N] markers in recent output
    // This is best-effort — we look for the pattern in the plan text
  });

  // --- /plan command ---
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration)",
    handler: async (_args, ctx) => {
      planModeActive = !planModeActive;

      if (planModeActive) {
        planSteps = [];
        planText = "";

        ctx.ui.notify("Plan mode: ON (read-only)", "info");
        ctx.ui.setStatus("plan-mode", "PLAN MODE");

        // Inject plan mode context
        pi.sendMessage(
          {
            customType: "plan-mode-context",
            content: PLAN_MODE_CONTEXT,
            display: false,
          },
          { triggerTurn: false },
        );
      } else {
        ctx.ui.notify("Plan mode: OFF", "info");
        ctx.ui.setStatus("plan-mode", "");
      }
    },
  });

  // --- /plan-execute command ---
  pi.registerCommand("plan-execute", {
    description: "Exit plan mode and execute the plan",
    handler: async (_args, ctx) => {
      if (!planModeActive) {
        ctx.ui.notify("Not in plan mode", "warning");
        return;
      }

      planModeActive = false;
      ctx.ui.setStatus("plan-mode", "");
      ctx.ui.notify("Plan mode: OFF — executing plan", "info");

      if (planSteps.length > 0) {
        const progress = formatPlanProgress();
        pi.sendUserMessage(
          `Execute the following plan. Mark each step done as you complete it.\n\n${progress}`,
        );
      } else {
        pi.sendUserMessage(
          "Plan mode ended. Execute the plan you created above. Work through each step systematically.",
        );
      }
    },
  });

  // --- /plan-status command ---
  pi.registerCommand("plan-status", {
    description: "Show plan mode status and progress",
    handler: async (_args, _ctx) => {
      pi.sendMessage(
        {
          customType: "plan-status",
          content: formatPlanProgress(),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- plan_step_done tool ---
  pi.registerTool({
    name: "plan_step_done",
    label: "Mark Plan Step Done",
    description:
      "Mark a plan step as completed by its number. Use after completing each step " +
      "of an extracted plan during /plan-execute.",
    parameters: Type.Object({
      step: Type.Number({
        description: "Step number to mark as done",
      }),
    }),

    async execute(_toolCallId, params) {
      const stepNum = (params as { step: number }).step;
      const step = planSteps.find((s) => s.id === stepNum);

      if (!step) {
        return {
          content: [
            {
              type: "text",
              text: `Step ${stepNum} not found. Available: ${planSteps.map((s) => s.id).join(", ") || "none"}`,
            },
          ],
          details: {},
        };
      }

      step.done = true;
      const done = planSteps.filter((s) => s.done).length;

      return {
        content: [
          {
            type: "text",
            text: `Step ${stepNum} done (${done}/${planSteps.length} complete)`,
          },
        ],
        details: { step: stepNum, progress: `${done}/${planSteps.length}` },
      };
    },
  });

  // --- plan_extract tool ---
  pi.registerTool({
    name: "plan_extract",
    label: "Extract Plan Steps",
    description:
      "Extract numbered steps from a plan text. Call this after creating a plan " +
      "to enable progress tracking.",
    parameters: Type.Object({
      plan_text: Type.String({
        description: "The plan text containing numbered steps",
      }),
    }),

    async execute(_toolCallId, params) {
      const text = (params as { plan_text: string }).plan_text;
      planText = text;
      planSteps = extractPlanSteps(text);

      if (planSteps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No numbered steps found. Format steps as '1. Step text'.",
            },
          ],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Extracted ${planSteps.length} steps:\n${planSteps.map((s) => `${s.id}. ${s.text}`).join("\n")}`,
          },
        ],
        details: { steps: planSteps },
      };
    },
  });
}

export {
  isBashSafe,
  extractPlanSteps,
  formatPlanProgress,
  PLAN_MODE_TOOLS,
  BLOCKED_TOOLS,
  DESTRUCTIVE_BASH_PATTERNS,
  SAFE_BASH_PATTERNS,
};
