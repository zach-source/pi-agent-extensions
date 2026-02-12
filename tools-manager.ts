/**
 * Tools Manager Extension for Pi
 *
 * Provides a /tools command to enable/disable tools via a config file.
 * When tools are disabled, the agent is instructed not to use them
 * via injected system context.
 *
 * Config is stored in .pi-tool-config.json in the project root.
 *
 * Commands:
 *   /tools           - List all tools and their enabled/disabled state
 *   /tools-enable    - Enable a tool by name
 *   /tools-disable   - Disable a tool by name
 *   /tools-reset     - Reset to all tools enabled
 *
 * Tools:
 *   manage_tools     - LLM-callable tool to query/modify tool config
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

// Local StringEnum helper
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: Record<string, unknown>,
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// --- State ---

const CONFIG_FILE = ".pi-tool-config.json";

interface ToolConfig {
  disabledTools: string[];
}

let config: ToolConfig = { disabledTools: [] };
let currentCwd = "";

async function loadConfig(cwd: string): Promise<void> {
  currentCwd = cwd;
  try {
    const content = await readFile(join(cwd, CONFIG_FILE), "utf-8");
    const parsed = JSON.parse(content) as ToolConfig;
    config = {
      disabledTools: Array.isArray(parsed.disabledTools)
        ? parsed.disabledTools
        : [],
    };
  } catch {
    config = { disabledTools: [] };
  }
}

async function saveConfig(): Promise<void> {
  if (!currentCwd) return;
  await writeFile(
    join(currentCwd, CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n",
  );
}

function formatToolList(disabledTools: string[]): string {
  if (disabledTools.length === 0) {
    return "All tools are enabled. Use `/tools-disable <name>` to disable a tool.";
  }

  const lines = [
    `${disabledTools.length} tool(s) disabled:`,
    "",
    ...disabledTools.map((t) => `  - ${t}`),
    "",
    "Use `/tools-enable <name>` to re-enable, or `/tools-reset` to enable all.",
  ];
  return lines.join("\n");
}

function buildToolRestrictionContext(disabledTools: string[]): string {
  if (disabledTools.length === 0) return "";

  return (
    `\n\n[Tool Restrictions] The following tools have been disabled by the user. ` +
    `Do NOT use them: ${disabledTools.join(", ")}. ` +
    `If a task requires a disabled tool, inform the user and suggest enabling it with /tools-enable.`
  );
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Load config and inject restrictions on session start
  pi.on("session_start", async (_event, ctx) => {
    await loadConfig(ctx.cwd);

    if (config.disabledTools.length > 0) {
      ctx.ui.setStatus(
        "tools",
        `tools: ${config.disabledTools.length} disabled`,
      );

      // Inject tool restriction context
      pi.sendMessage(
        {
          customType: "tool-restrictions",
          content: buildToolRestrictionContext(config.disabledTools),
          display: false,
        },
        { triggerTurn: false },
      );
    }
  });

  // Intercept tool calls for disabled tools
  pi.on("tool_call", async (event, _ctx) => {
    const toolName =
      (event as Record<string, unknown>).toolName?.toString() ?? "";

    if (config.disabledTools.includes(toolName)) {
      return {
        block: true,
        reason: `Tool "${toolName}" is disabled. Use /tools-enable ${toolName} to re-enable.`,
      };
    }
  });

  // --- /tools command ---
  pi.registerCommand("tools", {
    description: "List tool enable/disable status",
    handler: async (_args, ctx) => {
      await loadConfig(ctx.cwd);

      pi.sendMessage(
        {
          customType: "tools-status",
          content: `## Tool Status\n\n${formatToolList(config.disabledTools)}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /tools-enable command ---
  pi.registerCommand("tools-enable", {
    description: "Enable a tool: /tools-enable <name>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /tools-enable <tool-name>", "warning");
        return;
      }

      const toolName = args.trim();
      config.disabledTools = config.disabledTools.filter((t) => t !== toolName);
      await saveConfig();

      ctx.ui.notify(`Enabled tool: ${toolName}`, "info");

      if (config.disabledTools.length > 0) {
        ctx.ui.setStatus(
          "tools",
          `tools: ${config.disabledTools.length} disabled`,
        );
      } else {
        ctx.ui.setStatus("tools", "");
      }
    },
  });

  // --- /tools-disable command ---
  pi.registerCommand("tools-disable", {
    description: "Disable a tool: /tools-disable <name>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /tools-disable <tool-name>", "warning");
        return;
      }

      const toolName = args.trim();
      if (!config.disabledTools.includes(toolName)) {
        config.disabledTools.push(toolName);
        await saveConfig();
      }

      ctx.ui.notify(`Disabled tool: ${toolName}`, "info");
      ctx.ui.setStatus(
        "tools",
        `tools: ${config.disabledTools.length} disabled`,
      );

      // Inject updated restrictions
      pi.sendMessage(
        {
          customType: "tool-restrictions",
          content: buildToolRestrictionContext(config.disabledTools),
          display: false,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /tools-reset command ---
  pi.registerCommand("tools-reset", {
    description: "Reset all tools to enabled",
    handler: async (_args, ctx) => {
      config.disabledTools = [];
      await saveConfig();
      ctx.ui.notify("All tools re-enabled", "info");
      ctx.ui.setStatus("tools", "");
    },
  });

  // --- manage_tools tool ---
  pi.registerTool({
    name: "manage_tools",
    label: "Manage Tools",
    description:
      "Query or modify the tool configuration. " +
      "Actions: 'list' (show disabled tools), " +
      "'enable' (enable a tool by name), " +
      "'disable' (disable a tool by name), " +
      "'reset' (enable all tools).",
    parameters: Type.Object({
      action: StringEnum(["list", "enable", "disable", "reset"] as const, {
        description: "Action to perform",
      }),
      tool_name: Type.Optional(
        Type.String({
          description: "Tool name (required for enable/disable actions)",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { action, tool_name } = params as {
        action: string;
        tool_name?: string;
      };

      switch (action) {
        case "list":
          return {
            content: [
              {
                type: "text",
                text: formatToolList(config.disabledTools),
              },
            ],
            details: { disabled: config.disabledTools },
          };

        case "enable":
          if (!tool_name) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: tool_name required for enable action.",
                },
              ],
              details: {},
            };
          }
          config.disabledTools = config.disabledTools.filter(
            (t) => t !== tool_name,
          );
          await saveConfig();
          return {
            content: [
              {
                type: "text",
                text: `Enabled tool: ${tool_name}`,
              },
            ],
            details: { enabled: tool_name },
          };

        case "disable":
          if (!tool_name) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: tool_name required for disable action.",
                },
              ],
              details: {},
            };
          }
          if (!config.disabledTools.includes(tool_name)) {
            config.disabledTools.push(tool_name);
            await saveConfig();
          }
          return {
            content: [
              {
                type: "text",
                text: `Disabled tool: ${tool_name}`,
              },
            ],
            details: { disabled: tool_name },
          };

        case "reset":
          config.disabledTools = [];
          await saveConfig();
          return {
            content: [{ type: "text", text: "All tools re-enabled." }],
            details: {},
          };

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${action}`,
              },
            ],
            details: {},
          };
      }
    },
  });
}
