/**
 * Reload Runtime Extension for Pi
 *
 * Provides a command and LLM-callable tool to reload all extensions,
 * skills, prompts, and themes without restarting the session.
 *
 * Commands:
 *   /reload-runtime  - Reload everything
 *
 * Tools:
 *   reload_runtime   - LLM-callable reload trigger
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // --- /reload-runtime command ---
  pi.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      if (typeof ctx.reload === "function") {
        ctx.ui.notify("Reloading runtime...", "info");
        await ctx.reload();
      } else {
        ctx.ui.notify(
          "Runtime reload not supported in this Pi version. Please restart the session.",
          "warning",
        );
      }
    },
  });

  // --- reload_runtime tool ---
  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "Reload all extensions, skills, prompts, and themes without restarting the session. " +
      "Use after modifying extension files to pick up changes immediately.",
    parameters: Type.Object({}),
    async execute() {
      pi.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [
          {
            type: "text",
            text: "Queued /reload-runtime as a follow-up command.",
          },
        ],
        details: {},
      };
    },
  });
}
