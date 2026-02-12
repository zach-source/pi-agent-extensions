/**
 * Code Reviewer Extension for Pi
 *
 * Structured code review with prioritized findings (P0-P3),
 * confidence scores, and file:line anchoring. Ported from
 * oh-my-pi's reviewer agent.
 *
 * Commands:
 *   /review          - Start code review (git diff or specific files)
 *   /review-pr       - Review a pull request by number
 *
 * Tools:
 *   report_finding   - Report a structured code review finding
 *   submit_verdict   - Submit final review verdict
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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

// --- Types ---

interface Finding {
  title: string;
  body: string;
  priority: string;
  confidence: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

let findings: Finding[] = [];

// --- Priority definitions ---

const PRIORITY_INFO: Record<string, { label: string; symbol: string }> = {
  P0: { label: "Critical", symbol: "!!!" },
  P1: { label: "Urgent", symbol: "!!" },
  P2: { label: "Normal", symbol: "!" },
  P3: { label: "Info", symbol: "~" },
};

function formatFindings(items: Finding[]): string {
  if (items.length === 0) return "No findings reported.";

  const sorted = [...items].sort((a, b) => {
    const pa = a.priority.charCodeAt(1);
    const pb = b.priority.charCodeAt(1);
    return pa - pb;
  });

  const lines: string[] = [`## Review Findings (${items.length})`, ""];

  for (const f of sorted) {
    const info = PRIORITY_INFO[f.priority] || PRIORITY_INFO.P3;
    lines.push(
      `### ${info.symbol} [${f.priority}] ${f.title} (confidence: ${(f.confidence * 100).toFixed(0)}%)`,
    );
    lines.push(`**File:** ${f.filePath}:${f.lineStart}-${f.lineEnd}`);
    lines.push(f.body);
    lines.push("");
  }

  return lines.join("\n");
}

// --- Review prompts ---

function buildReviewPrompt(target: string, cwd: string): string {
  return `# CODE REVIEW

## Role
Senior engineer reviewing proposed changes. Goal: identify bugs the author would want fixed before merge.

## Procedure
1. Run \`git diff\` (or \`gh pr diff <number>\`) to view the patch
2. Read modified files for full context around the changes
3. For each issue found, call the \`report_finding\` tool
4. When done, call \`submit_verdict\` with your overall assessment

Bash is read-only: \`git diff\`, \`git log\`, \`git show\`, \`gh pr diff\`. No file edits or builds.

## Criteria — Report an issue ONLY when ALL conditions hold:
- **Provable impact**: Show specific affected code paths (no speculation)
- **Actionable**: Discrete fix, not vague "consider improving X"
- **Unintentional**: Clearly not a deliberate design choice
- **Introduced in patch**: Don't flag pre-existing bugs
- **No unstated assumptions**: Bug doesn't rely on assumptions about codebase or author intent

## Priority Levels

| Level | Criteria | Example |
|-------|----------|---------|
| P0 | Blocks release/operations; universal (no input assumptions) | Data corruption, auth bypass |
| P1 | High impact; fix next cycle | Race condition under load |
| P2 | Medium; fix eventually | Edge case mishandling |
| P3 | Info; nice to have | Suboptimal but correct |

## Finding Format
- **Title**: Imperative, ≤80 chars (e.g., "Handle null response from API")
- **Body**: Bug description, trigger condition, impact. Neutral tone, one paragraph max.

## Verdict
After all findings are reported, call \`submit_verdict\` with:
- **correctness**: "correct" (no bugs/blockers) or "incorrect"
- **explanation**: 1-3 sentence summary. Don't repeat findings.
- **confidence**: 0.0-1.0

Correctness ignores non-blocking issues (style, docs, nits).

## Target
${target || "Review the current working tree changes (git diff)."}

Working directory: ${cwd}`;
}

function buildPRReviewPrompt(prNumber: string, cwd: string): string {
  return buildReviewPrompt(
    `Review pull request #${prNumber}. Use \`gh pr diff ${prNumber}\` to get the diff and \`gh pr view ${prNumber}\` for context.`,
    cwd,
  );
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Reset findings on session start
  pi.on("session_start", async () => {
    findings = [];
  });

  // --- report_finding tool ---
  pi.registerTool({
    name: "report_finding",
    label: "Report Finding",
    description:
      "Report a structured code review finding with priority and file location. " +
      "Use during /review to report issues found in the code.",
    parameters: Type.Object({
      title: Type.String({
        description:
          "≤80 chars, imperative. E.g., 'Handle null response from API'",
      }),
      body: Type.String({
        description:
          "Bug description, trigger condition, impact. One paragraph max.",
      }),
      priority: StringEnum(["P0", "P1", "P2", "P3"] as const, {
        description:
          "P0=critical (blocks release), P1=urgent, P2=normal, P3=info",
      }),
      confidence: Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Confidence this is a real issue (0.0-1.0)",
      }),
      file_path: Type.String({ description: "Path to the affected file" }),
      line_start: Type.Number({ description: "Start line of the issue" }),
      line_end: Type.Number({ description: "End line of the issue" }),
    }),

    async execute(_toolCallId, params) {
      const p = params as {
        title: string;
        body: string;
        priority: string;
        confidence: number;
        file_path: string;
        line_start: number;
        line_end: number;
      };

      const finding: Finding = {
        title: p.title,
        body: p.body,
        priority: p.priority,
        confidence: p.confidence,
        filePath: p.file_path,
        lineStart: p.line_start,
        lineEnd: p.line_end,
      };

      findings.push(finding);

      const info = PRIORITY_INFO[p.priority] || PRIORITY_INFO.P3;

      return {
        content: [
          {
            type: "text",
            text: `Finding #${findings.length} recorded: [${p.priority}/${info.label}] ${p.title} at ${p.file_path}:${p.line_start}`,
          },
        ],
        details: { finding, totalFindings: findings.length },
      };
    },
  });

  // --- submit_verdict tool ---
  pi.registerTool({
    name: "submit_verdict",
    label: "Submit Verdict",
    description:
      "Submit the final code review verdict after all findings have been reported. " +
      "Summarizes whether the change is correct or has blocking issues.",
    parameters: Type.Object({
      correctness: StringEnum(["correct", "incorrect"] as const, {
        description:
          "'correct' if no bugs/blockers, 'incorrect' if blocking issues found",
      }),
      explanation: Type.String({
        description:
          "1-3 sentence verdict summary. Don't repeat individual findings.",
      }),
      confidence: Type.Number({
        minimum: 0,
        maximum: 1,
        description: "Confidence in verdict (0.0-1.0)",
      }),
    }),

    async execute(_toolCallId, params) {
      const { correctness, explanation, confidence } = params as {
        correctness: string;
        explanation: string;
        confidence: number;
      };

      const symbol = correctness === "correct" ? "PASS" : "FAIL";

      const report = [
        `# Review Verdict: ${symbol}`,
        "",
        `**Correctness:** ${correctness}`,
        `**Confidence:** ${(confidence * 100).toFixed(0)}%`,
        `**Explanation:** ${explanation}`,
        "",
        formatFindings(findings),
      ].join("\n");

      // Display the full report
      pi.sendMessage(
        {
          customType: "review-verdict",
          content: report,
          display: true,
        },
        { triggerTurn: false },
      );

      // Reset for next review
      const reportedFindings = [...findings];
      findings = [];

      return {
        content: [
          {
            type: "text",
            text: `Review complete: ${symbol} (${reportedFindings.length} finding(s))`,
          },
        ],
        details: {
          correctness,
          explanation,
          confidence,
          findings: reportedFindings,
        },
      };
    },
  });

  // --- /review command ---
  pi.registerCommand("review", {
    description: "Start a structured code review of current changes",
    handler: async (args, ctx) => {
      findings = [];
      ctx.ui.notify("Starting code review...", "info");
      ctx.ui.setStatus("reviewer", "review: active");

      const prompt = buildReviewPrompt(args || "", ctx.cwd);
      pi.sendUserMessage(prompt);
    },
  });

  // --- /review-pr command ---
  pi.registerCommand("review-pr", {
    description: "Review a pull request: /review-pr <number>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /review-pr <number>", "warning");
        return;
      }

      findings = [];
      ctx.ui.notify(`Reviewing PR #${args.trim()}...`, "info");
      ctx.ui.setStatus("reviewer", `review: PR #${args.trim()}`);

      const prompt = buildPRReviewPrompt(args.trim(), ctx.cwd);
      pi.sendUserMessage(prompt);
    },
  });
}
