/**
 * Custom Compaction Extension for Pi
 *
 * Hooks into session compaction to preserve critical context.
 * When compaction occurs, saves a summary to Graphiti (if available)
 * and builds a rich preamble with project state, pending tasks,
 * and key decisions.
 *
 * Events:
 *   session.compacting  - Intercept compaction to build custom preamble
 *   session_start       - Load saved context from previous compactions
 *
 * Commands:
 *   /compact-save    - Manually save current context to Graphiti
 *   /compact-config  - Toggle compaction features
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

// --- Types ---

interface CompactionState {
  keyDecisions: string[];
  currentGoals: string[];
  blockers: string[];
  completedTasks: string[];
  lastCompactedAt: string | null;
  compactionCount: number;
}

const STATE_DIR = ".pi";
const STATE_FILE = "compaction-context.json";

function defaultState(): CompactionState {
  return {
    keyDecisions: [],
    currentGoals: [],
    blockers: [],
    completedTasks: [],
    lastCompactedAt: null,
    compactionCount: 0,
  };
}

let state: CompactionState = defaultState();

let currentCwd = "";
let graphitiAvailable = false;

// --- State persistence ---

async function loadState(cwd: string): Promise<void> {
  currentCwd = cwd;
  try {
    const content = await readFile(join(cwd, STATE_DIR, STATE_FILE), "utf-8");
    const parsed = JSON.parse(content) as CompactionState;
    state = { ...defaultState(), ...parsed };
  } catch {
    // No saved state, reset to defaults
    state = defaultState();
  }
}

async function saveState(): Promise<void> {
  if (!currentCwd) return;
  try {
    await mkdir(join(currentCwd, STATE_DIR), { recursive: true });
    await writeFile(
      join(currentCwd, STATE_DIR, STATE_FILE),
      JSON.stringify(state, null, 2) + "\n",
    );
  } catch {
    // Silently fail
  }
}

// --- Graphiti integration ---

async function saveToGraphiti(summary: string): Promise<boolean> {
  if (!graphitiAvailable) return false;

  try {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_memory",
        arguments: {
          name: `Compaction: session context (${new Date().toISOString().slice(0, 10)})`,
          episode_body: summary,
          source: "text",
          source_description: "pi-compaction-extension auto-save",
        },
      },
    };

    const resp = await fetch("http://127.0.0.1:51847/mcp/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    return resp.ok;
  } catch {
    return false;
  }
}

async function checkGraphiti(): Promise<boolean> {
  try {
    const resp = await fetch("http://127.0.0.1:51847/mcp/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "pi-compaction-ext", version: "1.0" },
          capabilities: {},
          protocolVersion: "2025-03-26",
        },
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// --- Compaction preamble builder ---

function buildCompactionPreamble(): string {
  const sections: string[] = [];

  sections.push("## Session Context (preserved across compaction)");
  sections.push(
    `Compaction #${state.compactionCount} at ${new Date().toISOString()}`,
  );

  if (state.currentGoals.length > 0) {
    sections.push("\n### Current Goals");
    for (const goal of state.currentGoals) {
      sections.push(`- ${goal}`);
    }
  }

  if (state.keyDecisions.length > 0) {
    sections.push("\n### Key Decisions Made");
    for (const decision of state.keyDecisions) {
      sections.push(`- ${decision}`);
    }
  }

  if (state.completedTasks.length > 0) {
    sections.push(`\n### Recently Completed (${state.completedTasks.length})`);
    // Only keep last 10
    const recent = state.completedTasks.slice(-10);
    for (const task of recent) {
      sections.push(`- ${task}`);
    }
  }

  if (state.blockers.length > 0) {
    sections.push("\n### Blockers / Open Issues");
    for (const blocker of state.blockers) {
      sections.push(`- ${blocker}`);
    }
  }

  return sections.join("\n");
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Load state and check Graphiti on session start
  pi.on("session_start", async (_event, ctx) => {
    await loadState(ctx.cwd);
    graphitiAvailable = await checkGraphiti();

    if (state.compactionCount > 0) {
      ctx.ui.setStatus("compaction", `compactions: ${state.compactionCount}`);
    }

    // Warn if compaction context has no persistence backend
    if (!graphitiAvailable && state.compactionCount === 0) {
      const hasLocalState =
        state.keyDecisions.length > 0 ||
        state.currentGoals.length > 0 ||
        state.blockers.length > 0;
      if (!hasLocalState) {
        ctx.ui.notify(
          "Compaction context: no Graphiti connection and no local state — decisions/goals won't survive compaction until one is available.",
          "warning",
        );
      }
    }
  });

  // Hook into compaction (must match Pi runtime event name)
  pi.on("session_before_compact", async (event, ctx) => {
    state.compactionCount++;
    state.lastCompactedAt = new Date().toISOString();
    await saveState();

    // Build and inject custom preamble
    const preamble = buildCompactionPreamble();

    // Try to save to Graphiti
    if (graphitiAvailable) {
      await saveToGraphiti(preamble);
    }

    // Inject preamble into the compacted context
    const ev = event as Record<string, unknown>;
    if (typeof ev.setPreamble === "function") {
      (ev.setPreamble as (text: string) => void)(preamble);
    } else {
      // Fallback: send as message after compaction
      pi.sendMessage(
        {
          customType: "compaction-context",
          content: preamble,
          display: false,
        },
        { triggerTurn: false },
      );
    }

    ctx.ui.notify(
      `Context preserved (compaction #${state.compactionCount}${graphitiAvailable ? ", saved to Graphiti" : ""})`,
      "info",
    );
  });

  // --- compaction_context tool ---
  pi.registerTool({
    name: "compaction_context",
    label: "Compaction Context",
    description:
      "Manage the compaction context that persists across session compactions. " +
      "Use to add goals, decisions, blockers, and completed tasks that should " +
      "survive context window resets.",
    parameters: Type.Object({
      action: Type.String({
        description:
          "Action: 'add_goal', 'add_decision', 'add_blocker', 'complete_task', 'view', 'clear'",
      }),
      text: Type.Optional(
        Type.String({
          description: "Text for the item being added",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { action, text } = params as {
        action: string;
        text?: string;
      };

      switch (action) {
        case "add_goal":
          if (!text) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: text required for add_goal",
                },
              ],
              details: {},
            };
          }
          state.currentGoals.push(text);
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Added goal: ${text}`,
              },
            ],
            details: { goals: state.currentGoals },
          };

        case "add_decision":
          if (!text) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: text required for add_decision",
                },
              ],
              details: {},
            };
          }
          state.keyDecisions.push(text);
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Recorded decision: ${text}`,
              },
            ],
            details: { decisions: state.keyDecisions },
          };

        case "add_blocker":
          if (!text) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: text required for add_blocker",
                },
              ],
              details: {},
            };
          }
          state.blockers.push(text);
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Added blocker: ${text}`,
              },
            ],
            details: { blockers: state.blockers },
          };

        case "complete_task":
          if (!text) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: text required for complete_task",
                },
              ],
              details: {},
            };
          }
          state.completedTasks.push(text);
          // Remove from goals if it matches
          state.currentGoals = state.currentGoals.filter((g) => g !== text);
          // Remove from blockers if resolved
          state.blockers = state.blockers.filter((b) => b !== text);
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Completed: ${text}`,
              },
            ],
            details: { completed: state.completedTasks },
          };

        case "view":
          return {
            content: [{ type: "text", text: buildCompactionPreamble() }],
            details: { state },
          };

        case "clear":
          state.keyDecisions = [];
          state.currentGoals = [];
          state.blockers = [];
          state.completedTasks = [];
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: "Cleared all compaction context.",
              },
            ],
            details: {},
          };

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${action}. Use: add_goal, add_decision, add_blocker, complete_task, view, clear.`,
              },
            ],
            details: {},
          };
      }
    },
  });

  // --- /compact-save command ---
  pi.registerCommand("compact-save", {
    description: "Manually save current context to Graphiti",
    handler: async (_args, ctx) => {
      const preamble = buildCompactionPreamble();

      if (graphitiAvailable) {
        const saved = await saveToGraphiti(preamble);
        ctx.ui.notify(
          saved ? "Context saved to Graphiti" : "Failed to save to Graphiti",
          saved ? "info" : "error",
        );
      } else {
        ctx.ui.notify(
          "Graphiti not available. Context saved to local file only.",
          "warning",
        );
      }

      await saveState();
    },
  });

  // --- /compact-config command ---
  pi.registerCommand("compact-config", {
    description: "Show compaction context state",
    handler: async (_args, _ctx) => {
      const preamble = buildCompactionPreamble();

      pi.sendMessage(
        {
          customType: "compaction-config",
          content:
            preamble +
            `\n\nGraphiti: ${graphitiAvailable ? "connected" : "unavailable"}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
