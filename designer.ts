/**
 * Designer Extension for Pi
 *
 * UI/UX design agent that provides specialized prompts for design
 * implementation, review, and visual refinement. Includes an explicit
 * anti-slop patterns list to avoid generic AI aesthetics.
 *
 * Commands:
 *   /design          - Start a design implementation task
 *   /design-review   - Review existing UI for issues
 *
 * Ported from oh-my-pi's designer agent prompt.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- Design agent prompt ---

const DESIGNER_ROLE = `You are a Senior Design Engineer with 10+ years shipping production interfaces.
You implement UI, conduct design reviews, and refine components.

Strengths:
- Translate design intent into working UI code
- Identify UX issues: unclear states, missing feedback, poor hierarchy
- Accessibility: contrast, focus states, semantic markup, screen reader compatibility
- Visual consistency: spacing, typography, color usage, component patterns
- Responsive design, layout structure`;

const ANTI_SLOP_PATTERNS = `## AI Slop Patterns to AVOID

These are telltale signs of AI-generated UI. Never use them:

- **Glassmorphism everywhere**: blur effects, glass cards, glow borders used decoratively
- **Cyan-on-dark with purple gradients**: the generic 2024 AI color palette
- **Gradient text on metrics/headings**: decorative without meaning
- **Card grids with identical cards**: icon + heading + text repeated endlessly
- **Cards nested inside cards**: visual noise — flatten hierarchy instead
- **Large rounded-corner icons above every heading**: templated, no value
- **Hero metric layouts**: big number, small label, gradient accent — overused
- **Same spacing everywhere**: no rhythm, creates monotony
- **Center-aligned everything**: left-align with asymmetry feels more designed
- **Modals for everything**: lazy pattern, rarely the best solution
- **Pure black (#000) or pure white (#fff)**: always tint neutrals
- **Gray text on colored backgrounds**: use shade of background instead
- **Bounce/elastic easing**: dated, tacky — use exponential easing (ease-out-quart/expo)

## UX Anti-Patterns to AVOID
- Missing states (loading, empty, error, disabled)
- Redundant information (heading restates intro text)
- Every button styled as primary — hierarchy matters
- Empty states that say "nothing here" instead of guiding user`;

function buildDesignPrompt(task: string, cwd: string): string {
  const projectName = cwd.split("/").pop() || "project";

  return `# DESIGN: ${task || "Implementation Task"}

## Role
${DESIGNER_ROLE}

## Project
Name: ${projectName}
Working directory: ${cwd}

## Procedure

### If implementing UI:
1. Read existing components, tokens, patterns — reuse before inventing
2. Identify aesthetic direction (minimal, bold, editorial, etc.)
3. Implement explicit states: loading, empty, error, disabled, hover, focus
4. Verify accessibility: contrast, focus rings, semantic HTML
5. Test responsive behavior

### If reviewing UI:
1. Read files under review
2. Check for UX issues, accessibility gaps, visual inconsistencies
3. Cite file, line, concrete issue — no vague feedback
4. Suggest specific fixes with code when applicable

## Directives
- Prefer editing existing files over creating new ones
- Keep changes minimal and consistent with existing code style
- NEVER create documentation files unless explicitly requested

${ANTI_SLOP_PATTERNS}

## Critical
Every interface should prompt "how was this made?" not "which AI made this?"
Commit to a clear aesthetic direction and execute with precision.
Keep going until implementation is complete.

## Context
${task ? `Task: ${task}` : "Ask the user what they want designed or reviewed."}`;
}

function buildReviewPrompt(target: string, cwd: string): string {
  return `# DESIGN REVIEW

## Role
${DESIGNER_ROLE}

## Task
Review the following for design quality, accessibility, and UX issues:
${target || "Ask the user which files or components to review."}

## Review Checklist
1. **Visual Consistency**: spacing, typography, color usage, component patterns
2. **Accessibility**: contrast ratios, focus states, semantic HTML, ARIA attributes
3. **UX Completeness**: loading states, error states, empty states, disabled states
4. **Responsive Design**: mobile, tablet, desktop breakpoints
5. **Interaction Design**: hover states, transitions, feedback on actions
6. **Content Hierarchy**: information architecture, visual weight, readability

${ANTI_SLOP_PATTERNS}

## Output Format
For each issue found:
- **File**: path and line numbers
- **Issue**: concrete description
- **Impact**: who is affected and how
- **Fix**: specific code change suggested

Working directory: ${cwd}`;
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // --- /design command ---
  pi.registerCommand("design", {
    description: "Start a design implementation task with anti-slop guidance",
    handler: async (args, ctx) => {
      ctx.ui.notify("Starting design session...", "info");
      ctx.ui.setStatus("designer", "designer: active");

      const prompt = buildDesignPrompt(args || "", ctx.cwd);
      pi.sendUserMessage(prompt);
    },
  });

  // --- /design-review command ---
  pi.registerCommand("design-review", {
    description: "Review UI/UX for issues and anti-patterns",
    handler: async (args, ctx) => {
      ctx.ui.notify("Starting design review...", "info");
      ctx.ui.setStatus("designer", "review: active");

      const prompt = buildReviewPrompt(args || "", ctx.cwd);
      pi.sendUserMessage(prompt);
    },
  });
}
