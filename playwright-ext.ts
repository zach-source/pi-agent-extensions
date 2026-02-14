/**
 * Playwright Chrome Extension Guide for Pi
 *
 * Reference knowledge extension for working with Playwright and Chrome
 * extensions — loading extensions, CDP attachment, recording tools,
 * plugin frameworks, and Python packages.
 *
 * Commands:
 *   /playwright-ext       - Inject the full guide as context for a task
 *   /playwright-ext-help  - Display a formatted summary (no agent turn)
 *
 * No tools, no state, no event handlers — pure guidance.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Reference guide ---

const PLAYWRIGHT_EXT_GUIDE = `## 1. Load Chrome Extensions (Persistent Context)

Extensions work in Chromium when launched with a **persistent context**.
Branded Chrome/Edge removed the flags needed to side-load extensions,
so Playwright recommends using the Chromium it bundles.

\`\`\`ts
import { chromium } from "playwright";
import path from "path";

const extensionPath = path.join(process.cwd(), "my-extension");
const userDataDir = path.join(process.cwd(), "pw-profile");

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    \\\`--disable-extensions-except=\\\${extensionPath}\\\`,
    \\\`--load-extension=\\\${extensionPath}\\\`,
  ],
});

const page = await context.newPage();
await page.goto("https://example.com");
\`\`\`

## 2. CDP Attachment (Existing Chrome Session)

Attach Playwright to an already-running Chrome/Chromium session via
Chrome DevTools Protocol. Useful for signed-in state, existing tabs, etc.

- **Node**: \`browser.connectOverCDP(endpointURL)\`
- **Python**: \`browser.connect_over_cdp(endpoint_url)\`

## 3. Recording Extensions

Chrome Web Store extensions that bring Playwright recording into the browser:

- **Playwright CRX** — records in-browser and can play back scripts
- **Playwright Chrome Recorder** — records interactions and generates Playwright code

## 4. Plugin Frameworks

Extend Playwright with extra capabilities (stealth, proxies, etc.):

- **@divriots/playwright-extra** — plugin framework for Playwright (Node)
- Community "Playwright Extra" wrappers that add plugin support
  (CAPTCHA/proxy/stealth, etc.)
- **awesome-playwright** — curated list of tools/utilities

> Note: anything marketed as "stealth" or "CAPTCHA solving" can cross
> legal/ToS lines depending on use.

## 5. Python Packages

- **pytest-playwright** — official pytest plugin for Playwright
- **playwright-stealth** (Python) — community stealth package (quality/ethics vary)

## 6. Raspberry Pi / ARM64

Playwright support depends on architecture/OS. Playwright's Python release
notes mention running tests inside Docker on Raspberry Pi (ARM64 context).
Use the official Docker images for best compatibility.`;

function buildPlaywrightExtPrompt(task: string, cwd: string): string {
  const projectName = cwd.split("/").pop() || "project";

  return `# Playwright + Chrome Extensions Guide

## Project
Name: ${projectName}
Working directory: ${cwd}

${PLAYWRIGHT_EXT_GUIDE}

## Context
${task ? `Task: ${task}` : "Ask the user what they need help with (testing a Chrome extension, reusing an existing Chrome profile, recording scripts, scraping, Raspberry Pi, etc.)."}`;
}

const HELP_SUMMARY = `**Playwright + Chrome Extensions — Quick Reference**

| Topic | Key Detail |
|-------|------------|
| Load extensions | \`launchPersistentContext\` + \`--load-extension\` flag |
| CDP attachment | \`connectOverCDP\` (Node) / \`connect_over_cdp\` (Python) |
| Recording | Playwright CRX, Chrome Recorder extensions |
| Plugin frameworks | \`@divriots/playwright-extra\`, awesome-playwright |
| Python packages | \`pytest-playwright\`, \`playwright-stealth\` |
| Raspberry Pi | ARM64 via Docker images |

Use \`/playwright-ext [task]\` to inject the full guide with code examples.`;

// --- Extension ---

export default function (pi: ExtensionAPI) {
  pi.registerCommand("playwright-ext", {
    description: "Inject the Playwright + Chrome extensions guide for a task",
    handler: async (args, ctx) => {
      ctx.ui.notify("Loading Playwright extensions guide...", "info");

      const prompt = buildPlaywrightExtPrompt(args || "", ctx.cwd);
      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("playwright-ext-help", {
    description: "Display a summary of Playwright + Chrome extension options",
    handler: async (_args, _ctx) => {
      pi.sendMessage(
        {
          customType: "playwright-ext-help",
          content: HELP_SUMMARY,
          display: "block",
        },
        { triggerTurn: false },
      );
    },
  });
}
