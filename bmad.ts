/**
 * BMAD Method Extension for Pi
 *
 * Brings the full BMAD (Breakthrough Method for Agile AI-Driven Development)
 * methodology into Pi as a native extension. Provides structured workflows
 * across 4 phases with 9 specialized agent roles.
 *
 * Tools:
 *   bmad_config          - Load merged project + global config
 *   bmad_update_status   - Mark a workflow complete in status tracker
 *   bmad_save_document   - Save document with auto-generated path
 *   bmad_get_template    - Get template with variables substituted
 *
 * Commands:
 *   /bmad-init                    - Initialize BMAD in current project
 *   /bmad-status                  - Show workflow progress and recommendations
 *   /bmad-product-brief           - Create product brief (Phase 1)
 *   /bmad-brainstorm              - Structured brainstorming (Phase 1)
 *   /bmad-research                - Market/competitive research (Phase 1)
 *   /bmad-prd                     - Product Requirements Document (Phase 2)
 *   /bmad-tech-spec               - Technical Specification (Phase 2)
 *   /bmad-create-ux-design        - UX design workflow (Phase 2)
 *   /bmad-architecture            - System architecture design (Phase 3)
 *   /bmad-solutioning-gate-check  - Validate architecture (Phase 3)
 *   /bmad-sprint-planning         - Plan sprint iterations (Phase 4)
 *   /bmad-create-story            - Create user story document (Phase 4)
 *   /bmad-dev-story               - Implement a user story (Phase 4)
 *   /bmad-create-agent            - Create custom agent skill
 *   /bmad-create-workflow          - Create custom workflow command
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

// Local StringEnum helper (avoids runtime dependency on @mariozechner/pi-ai)
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

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BmadConfig {
  version: string;
  projectName: string;
  projectType: string;
  projectLevel: number;
  userName: string;
  outputFolder: string;
  workflowStatusFile: string;
  sprintStatusFile: string;
  paths: { docs: string; stories: string; tests: string };
}

export interface WorkflowEntry {
  name: string;
  phase: number;
  status: string;
  description: string;
}

export interface WorkflowDef {
  name: string;
  phase: number;
  agent: string;
  description: string;
  defaultStatus: (level: number) => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

export const BMAD_VERSION = "6.0.0";

export const LEVEL_DEFS = [
  { level: 0, label: "Single atomic change", stories: "1 story" },
  { level: 1, label: "Small feature set", stories: "1-10 stories" },
  { level: 2, label: "Medium feature set", stories: "5-15 stories" },
  { level: 3, label: "Complex integration", stories: "12-40 stories" },
  { level: 4, label: "Enterprise expansion", stories: "40+ stories" },
] as const;

export const PHASES = [
  { phase: 1, name: "Analysis", required: false },
  { phase: 2, name: "Planning", required: true },
  { phase: 3, name: "Solutioning", required: false },
  { phase: 4, name: "Implementation", required: true },
] as const;

export const WORKFLOW_DEFS: WorkflowDef[] = [
  // Phase 1 - Analysis
  {
    name: "product-brief",
    phase: 1,
    agent: "Business Analyst",
    description: "Create comprehensive product brief",
    defaultStatus: () => "optional",
  },
  {
    name: "brainstorm",
    phase: 1,
    agent: "Creative Intelligence",
    description: "Structured brainstorming session",
    defaultStatus: () => "optional",
  },
  {
    name: "research",
    phase: 1,
    agent: "Creative Intelligence",
    description: "Market and competitive research",
    defaultStatus: () => "optional",
  },
  // Phase 2 - Planning
  {
    name: "prd",
    phase: 2,
    agent: "Product Manager",
    description: "Product Requirements Document",
    defaultStatus: (l) => (l >= 2 ? "required" : "recommended"),
  },
  {
    name: "tech-spec",
    phase: 2,
    agent: "Product Manager",
    description: "Technical Specification",
    defaultStatus: (l) => (l <= 1 ? "required" : "optional"),
  },
  {
    name: "create-ux-design",
    phase: 2,
    agent: "UX Designer",
    description: "UX/UI design workflow",
    defaultStatus: () => "optional",
  },
  // Phase 3 - Solutioning
  {
    name: "architecture",
    phase: 3,
    agent: "System Architect",
    description: "System architecture design",
    defaultStatus: (l) => (l >= 2 ? "required" : "optional"),
  },
  {
    name: "solutioning-gate-check",
    phase: 3,
    agent: "System Architect",
    description: "Validate architecture against requirements",
    defaultStatus: () => "optional",
  },
  // Phase 4 - Implementation
  {
    name: "sprint-planning",
    phase: 4,
    agent: "Scrum Master",
    description: "Plan sprint iterations with stories",
    defaultStatus: () => "required",
  },
  {
    name: "create-story",
    phase: 4,
    agent: "Scrum Master",
    description: "Create detailed user story document",
    defaultStatus: () => "required",
  },
  {
    name: "dev-story",
    phase: 4,
    agent: "Developer",
    description: "Implement a user story end-to-end",
    defaultStatus: () => "required",
  },
  // Cross-phase (Builder)
  {
    name: "create-agent",
    phase: 0,
    agent: "Builder",
    description: "Create a custom agent skill",
    defaultStatus: () => "optional",
  },
  {
    name: "create-workflow",
    phase: 0,
    agent: "Builder",
    description: "Create a custom workflow command",
    defaultStatus: () => "optional",
  },
];

export const TEMPLATE_NAMES = [
  "config",
  "product-brief",
  "prd",
  "tech-spec",
  "architecture",
  "workflow-status",
  "sprint-status",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

const DEFAULT_CONFIG: BmadConfig = {
  version: BMAD_VERSION,
  projectName: "",
  projectType: "",
  projectLevel: 0,
  userName: "Developer",
  outputFolder: "docs",
  workflowStatusFile: "docs/bmm-workflow-status.yaml",
  sprintStatusFile: "docs/sprint-status.yaml",
  paths: { docs: "docs", stories: "docs/stories", tests: "tests" },
};

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

export function formatDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatISOTimestamp(): string {
  return new Date().toISOString();
}

export function substituteVars(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (match, key) => vars[key as string] ?? match,
  );
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ═══════════════════════════════════════════════════════════════════════════
// YAML Helpers (lightweight, format-specific)
// ═══════════════════════════════════════════════════════════════════════════

/** Parse a simple YAML config with one level of nesting. */
export function parseConfigYaml(
  content: string,
): Record<string, string | Record<string, string>> {
  const result: Record<string, string | Record<string, string>> = {};
  let currentSection: string | null = null;

  for (const line of content.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;

    const topLevel = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (topLevel) {
      const key = topLevel[1];
      const value = topLevel[2].replace(/^["']|["']$/g, "").trim();
      if (value) {
        result[key] = value;
        currentSection = null;
      } else {
        currentSection = key;
        if (!result[key]) result[key] = {};
      }
      continue;
    }

    if (currentSection) {
      const nested = line.match(/^\s+(\w[\w_-]*):\s*(.+)$/);
      if (nested) {
        const key = nested[1];
        const value = nested[2].replace(/^["']|["']$/g, "").trim();
        (result[currentSection] as Record<string, string>)[key] = value;
      }
    }
  }

  return result;
}

/** Parse workflow status YAML into WorkflowEntry array. */
export function parseWorkflowEntries(content: string): WorkflowEntry[] {
  const entries: WorkflowEntry[] = [];
  // Split on array item markers
  const blocks = content.split(/^\s*-\s+name:\s*/m).slice(1);

  for (const block of blocks) {
    const lines = block.split("\n");
    const name = lines[0]?.trim().replace(/^["']|["']$/g, "") || "";

    const getField = (field: string): string => {
      const m = block.match(new RegExp(`^\\s+${field}:\\s*(.+)$`, "m"));
      return m?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
    };

    if (name) {
      entries.push({
        name,
        phase: parseInt(getField("phase"), 10) || 0,
        status: getField("status"),
        description: getField("description"),
      });
    }
  }

  return entries;
}

/** Update a single workflow's status in the YAML content. */
export function updateStatusInYaml(
  content: string,
  workflow: string,
  filePath: string,
  timestamp: string,
): string {
  const lines = content.split("\n");
  let inBlock = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(new RegExp(`^\\s*-\\s*name:\\s*${workflow}\\s*$`))) {
      inBlock = true;
      continue;
    }
    if (inBlock && lines[i].match(/^\s+status:/)) {
      lines[i] = lines[i].replace(/status:\s*"[^"]*"/, `status: "${filePath}"`);
      inBlock = false;
    }
    if (inBlock && lines[i].match(/^\s*-\s*name:/)) {
      inBlock = false;
    }
  }

  // Update last_updated
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^last_updated:/)) {
      lines[i] = `last_updated: "${timestamp}"`;
      break;
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Config & Status Management
// ═══════════════════════════════════════════════════════════════════════════

function configFromYaml(
  raw: Record<string, string | Record<string, string>>,
): Partial<BmadConfig> {
  const bmm = (raw.bmm as Record<string, string>) || {};
  const paths = (raw.paths as Record<string, string>) || {};
  const str = (v: string | Record<string, string> | undefined): string =>
    typeof v === "string" ? v : "";

  return {
    projectName: str(raw.project_name),
    projectType: str(raw.project_type),
    projectLevel: parseInt(str(raw.project_level) || "0", 10),
    userName: str(raw.user_name) || undefined,
    outputFolder: str(raw.output_folder) || undefined,
    workflowStatusFile: bmm.workflow_status_file || undefined,
    sprintStatusFile: bmm.sprint_status_file || undefined,
    paths: {
      docs: paths.docs || "docs",
      stories: paths.stories || "docs/stories",
      tests: paths.tests || "tests",
    },
  };
}

export async function loadGlobalConfig(): Promise<Partial<BmadConfig>> {
  try {
    const globalPath = join(
      homedir(),
      ".claude",
      "config",
      "bmad",
      "config.yaml",
    );
    const content = await readFile(globalPath, "utf-8");
    return configFromYaml(parseConfigYaml(content));
  } catch {
    return {};
  }
}

export async function loadProjectConfig(
  cwd: string,
): Promise<Partial<BmadConfig> | null> {
  try {
    const projectPath = join(cwd, "bmad", "config.yaml");
    const content = await readFile(projectPath, "utf-8");
    return configFromYaml(parseConfigYaml(content));
  } catch {
    return null;
  }
}

export function mergeConfigs(
  global: Partial<BmadConfig>,
  project: Partial<BmadConfig>,
): BmadConfig {
  return {
    ...DEFAULT_CONFIG,
    ...global,
    ...project,
    paths: {
      ...DEFAULT_CONFIG.paths,
      ...global.paths,
      ...project.paths,
    },
  };
}

export async function loadConfig(cwd: string): Promise<BmadConfig | null> {
  const project = await loadProjectConfig(cwd);
  if (!project) return null;
  const global = await loadGlobalConfig();
  return mergeConfigs(global, project);
}

export async function loadStatus(
  cwd: string,
  config: BmadConfig,
): Promise<WorkflowEntry[]> {
  try {
    const statusPath = join(cwd, config.workflowStatusFile);
    const content = await readFile(statusPath, "utf-8");
    return parseWorkflowEntries(content);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Recommendation Logic
// ═══════════════════════════════════════════════════════════════════════════

export function isCompleted(status: string): boolean {
  return (
    status !== "required" &&
    status !== "optional" &&
    status !== "recommended" &&
    status !== "conditional" &&
    status !== "skipped" &&
    status !== ""
  );
}

export function getNextRecommendation(
  entries: WorkflowEntry[],
  level: number,
): string {
  const find = (name: string) => entries.find((e) => e.name === name);
  const done = (name: string) => {
    const e = find(name);
    return e ? isCompleted(e.status) : false;
  };

  // Phase 1: Recommend product-brief if nothing started
  if (!done("product-brief") && !done("prd") && !done("tech-spec")) {
    return "product-brief";
  }

  // Phase 2: Based on level
  if (level <= 1 && !done("tech-spec")) return "tech-spec";
  if (level >= 2 && !done("prd")) return "prd";

  // Phase 3: Architecture for level 2+
  if (level >= 2 && !done("architecture")) return "architecture";

  // Phase 4: Sprint planning
  if (!done("sprint-planning")) return "sprint-planning";
  if (!done("create-story")) return "create-story";

  return "dev-story";
}

export function formatStatusSymbol(
  entry: WorkflowEntry,
  recommendation: string,
): string {
  if (isCompleted(entry.status)) return "\u2713"; // checkmark
  if (entry.status === "skipped") return "~";
  if (entry.name === recommendation) return "\u2192"; // arrow
  if (entry.status === "required") return "!";
  return "-";
}

// ═══════════════════════════════════════════════════════════════════════════
// Embedded Templates
// ═══════════════════════════════════════════════════════════════════════════

const TEMPLATE_CONFIG = `# BMAD Project Configuration
# Generated: {{timestamp}}

project_name: "{{project_name}}"
project_type: "{{project_type}}"
project_level: {{project_level}}
output_folder: "docs"

bmm:
  workflow_status_file: "docs/bmm-workflow-status.yaml"
  sprint_status_file: "docs/sprint-status.yaml"

paths:
  docs: "docs"
  stories: "docs/stories"
  tests: "tests"
`;

const TEMPLATE_PRODUCT_BRIEF = `# Product Brief: {{project_name}}

**Date:** {{date}}
**Author:** {{user_name}}
**Project Type:** {{project_type}}
**Project Level:** {{project_level}}

---

## Executive Summary

[High-level overview of the product concept, market opportunity, and strategic fit]

---

## Problem Statement

### The Problem

[Core problem being solved and who experiences it]

### Why Now?

[Market timing, technology enablers, competitive pressure]

### Impact if Unsolved

[Consequences of not addressing this problem]

---

## Target Audience

### Primary Users

[Main user persona(s) with demographics and characteristics]

### Secondary Users

[Other stakeholders who interact with the product]

### User Needs

[Key needs, pain points, and desired outcomes]

---

## Solution Overview

### Proposed Solution

[High-level description of the product/feature]

### Key Features

[Core capabilities that address user needs]

### Value Proposition

[Why users would choose this over alternatives]

---

## Business Objectives

### Goals

[Measurable business outcomes]

### Success Metrics

[KPIs and measurement approach]

### Business Value

[Revenue impact, cost savings, strategic value]

---

## Scope

### In Scope

[What this project covers]

### Out of Scope

[Explicit exclusions]

### Future Considerations

[Items deferred to later phases]

---

## Key Stakeholders

[Stakeholder roles, interests, and influence level]

---

## Constraints and Assumptions

### Constraints

[Technical, business, resource, timeline constraints]

### Assumptions

[Key assumptions this brief relies on]

---

## Success Criteria

[Measurable criteria that define project success]

---

## Timeline and Milestones

### Target Launch

[Target date or timeframe]

### Key Milestones

[Major milestone dates and deliverables]

---

## Risks and Mitigation

[Key risks with probability, impact, and mitigation strategies]

---

## Next Steps

1. Create Product Requirements Document - \`/bmad-prd\`
2. Create Technical Specification - \`/bmad-tech-spec\`
3. Conduct research (optional) - \`/bmad-research\`

---

*Created using BMAD Method v{{version}} - Phase 1 (Analysis)*
`;

const TEMPLATE_PRD = `# Product Requirements Document: {{project_name}}

**Date:** {{date}}
**Author:** {{user_name}}
**Project Type:** {{project_type}}
**Project Level:** {{project_level}}
**Status:** Draft

---

## Document Overview

This PRD defines the functional and non-functional requirements for {{project_name}}.
It serves as the source of truth for what will be built.

**Related Documents:**
- Product Brief: [link to product brief if available]

---

## Executive Summary

[Product vision, scope, and strategic alignment]

---

## Product Goals

### Business Objectives

[Measurable business outcomes with targets]

### Success Metrics

[KPIs with baseline and target values]

---

## Functional Requirements

[Requirements in FR-XXX format with MoSCoW priority]

| ID | Requirement | Priority | Epic |
|----|-------------|----------|------|
| FR-001 | [Description] | Must | [Epic] |

---

## Non-Functional Requirements

[Requirements across: Performance, Security, Scalability, Reliability, Usability, Accessibility, Compliance]

| ID | Category | Requirement | Priority |
|----|----------|-------------|----------|
| NFR-001 | [Category] | [Description] | Must |

---

## Epics

[Epics in EPIC-XXX format grouping related functionality]

### EPIC-001: [Epic Name]

**Description:** [What this epic delivers]
**Priority:** [Must/Should/Could/Won't]
**Estimated Stories:** [Count]

---

## User Stories (High-Level)

[Stories in "As a [role], I want [goal], so that [benefit]" format]

---

## User Personas

[Key personas with goals, pain points, and behaviors]

---

## User Flows

[Critical user journeys through the system]

---

## Dependencies

### Internal Dependencies

[Dependencies on internal teams, systems, or services]

### External Dependencies

[Third-party services, APIs, or vendor dependencies]

---

## Assumptions

[Key assumptions this PRD relies on]

---

## Out of Scope

[Explicit exclusions with rationale]

---

## Open Questions

[Unresolved questions requiring stakeholder input]

---

## Appendix A: Requirements Traceability Matrix

| Epic ID | Epic Name | Functional Requirements | Story Count |
|---------|-----------|-------------------------|-------------|
| EPIC-001 | [Name] | FR-001, FR-002 | [Count] |

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | {{date}} | {{user_name}} | Initial PRD |

---

*Created using BMAD Method v{{version}} - Phase 2 (Planning)*
`;

const TEMPLATE_TECH_SPEC = `# Technical Specification: {{project_name}}

**Date:** {{date}}
**Author:** {{user_name}}
**Project Type:** {{project_type}}
**Project Level:** {{project_level}}
**Status:** Draft

---

## Document Overview

Focused technical planning for {{project_name}} (Level {{project_level}}).
Designed for smaller projects that need clear requirements without heavyweight PRD overhead.

**Related Documents:**
- Product Brief: [link if available]

---

## Problem & Solution

### Problem Statement

[Core problem being solved]

### Proposed Solution

[Technical approach at a high level]

---

## Requirements

### What Needs to Be Built

[Numbered list of concrete requirements]

### What This Does NOT Include

[Explicit exclusions]

---

## Technical Approach

### Technology Stack

[Languages, frameworks, libraries, infrastructure]

### Architecture Overview

[High-level architecture description or diagram]

### Data Model

[Key entities and relationships]

### API Design

[Endpoints, protocols, contracts]

---

## Implementation Plan

### Stories

[Ordered list of implementation stories with estimates]

| ID | Story | Estimate | Dependencies |
|----|-------|----------|--------------|
| S-001 | [Description] | [Points] | [Deps] |

### Development Phases

[How stories group into phases]

---

## Acceptance Criteria

[Testable criteria for each major feature]

---

## Non-Functional Requirements

### Performance

[Response times, throughput, resource limits]

### Security

[Authentication, authorization, data protection]

### Other

[Logging, monitoring, error handling]

---

## Dependencies

[External services, libraries, team dependencies]

---

## Risks & Mitigation

[Technical risks with probability, impact, and mitigation]

---

## Timeline

**Target Completion:** [Date or timeframe]

**Milestones:**
[Key milestone dates]

---

*Created using BMAD Method v{{version}} - Phase 2 (Planning)*
`;

const TEMPLATE_ARCHITECTURE = `# System Architecture: {{project_name}}

**Date:** {{date}}
**Author:** {{user_name}}
**Project Type:** {{project_type}}
**Project Level:** {{project_level}}
**Status:** Draft

---

## Executive Summary

[Architecture vision, key decisions, and rationale]

---

## Architectural Drivers

### Functional Requirements Summary

[Key FRs from PRD that drive architecture decisions]

### Non-Functional Requirements Summary

[Key NFRs with quantitative targets]

### Constraints

[Technical, business, and organizational constraints]

---

## System Overview

### High-Level Architecture

[Architecture pattern: monolith, microservices, serverless, etc.]

### Architecture Diagram

[ASCII or Mermaid diagram of major components and interactions]

---

## Technology Stack

### Frontend

[UI framework, state management, build tools]

### Backend

[Language, framework, runtime]

### Database

[Database type, engine, caching layer]

### Infrastructure

[Cloud provider, container orchestration, CI/CD]

### Third-Party Services

[External APIs, SaaS integrations]

---

## System Components

[Detailed component descriptions with responsibilities, interfaces, and dependencies]

---

## Data Architecture

### Data Model

[Entity-relationship description or diagram]

### Database Design

[Schema design, indexing strategy, partitioning]

### Data Flow

[How data moves through the system]

---

## API Design

### API Architecture

[REST, GraphQL, gRPC, event-driven]

### Key Endpoints

[Critical API endpoints with request/response formats]

### Authentication & Authorization

[Auth mechanism, token management, RBAC]

---

## Non-Functional Requirement Coverage

[How architecture addresses each NFR category]

### Performance

[Caching strategy, query optimization, CDN]

### Security

[Encryption, secrets management, network security]

### Scalability

[Horizontal/vertical scaling, load balancing]

### Reliability

[Redundancy, failover, backup strategy]

---

## Development Architecture

### Project Structure

[Directory layout, module organization]

### Coding Standards

[Style guide, linting, code review process]

### Testing Strategy

[Unit, integration, e2e, performance testing approach]

---

## Deployment Architecture

### Environments

[Dev, staging, production configuration]

### CI/CD Pipeline

[Build, test, deploy workflow]

### Monitoring & Observability

[Logging, metrics, alerting, tracing]

---

## Trade-offs & Decision Log

| Decision | Options Considered | Chosen | Rationale |
|----------|--------------------|--------|-----------|
| [Decision] | [Options] | [Choice] | [Why] |

---

## Risks & Mitigation

[Architecture-specific risks and mitigation strategies]

---

## Future Considerations

[Extensibility points, migration paths, technical debt awareness]

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | {{date}} | {{user_name}} | Initial architecture |

---

*Created using BMAD Method v{{version}} - Phase 3 (Solutioning)*
`;

const TEMPLATE_WORKFLOW_STATUS = `# BMAD Method Workflow Status
# Generated: {{timestamp}}
# Project: {{project_name}}

project_name: "{{project_name}}"
project_type: "{{project_type}}"
project_level: {{project_level}}
last_updated: "{{timestamp}}"

workflow_status:
  # Phase 1: Analysis (Optional but recommended)
  - name: product-brief
    phase: 1
    status: "optional"
    description: "Create comprehensive product brief"

  - name: brainstorm
    phase: 1
    status: "optional"
    description: "Structured brainstorming session"

  - name: research
    phase: 1
    status: "optional"
    description: "Market and competitive research"

  # Phase 2: Planning (Required - based on project level)
  - name: prd
    phase: 2
    status: "{{prd_status}}"
    description: "Product Requirements Document"

  - name: tech-spec
    phase: 2
    status: "{{tech_spec_status}}"
    description: "Technical Specification"

  - name: create-ux-design
    phase: 2
    status: "optional"
    description: "UX/UI design workflow"

  # Phase 3: Solutioning (Conditional on project level)
  - name: architecture
    phase: 3
    status: "{{architecture_status}}"
    description: "System architecture design"

  - name: solutioning-gate-check
    phase: 3
    status: "optional"
    description: "Validate architecture against requirements"
`;

const TEMPLATE_SPRINT_STATUS = `# BMAD Method Sprint Status
# Generated: {{timestamp}}
# Project: {{project_name}}

project_name: "{{project_name}}"
sprint_number: 1
sprint_goal: ""
sprint_start_date: "{{date}}"
sprint_end_date: ""
last_updated: "{{timestamp}}"

epics: []
  # Example:
  # - id: "EPIC-001"
  #   name: "Epic Name"
  #   status: "not-started"
  #   stories:
  #     - id: "STORY-001"
  #       name: "Story name"
  #       status: "not-started"
  #       file: "docs/stories/STORY-001.md"
  #       estimate: ""

metrics:
  total_epics: 0
  total_stories: 0
  stories_completed: 0
  stories_in_progress: 0
  stories_not_started: 0
`;

const TEMPLATES: Record<TemplateName, string> = {
  config: TEMPLATE_CONFIG,
  "product-brief": TEMPLATE_PRODUCT_BRIEF,
  prd: TEMPLATE_PRD,
  "tech-spec": TEMPLATE_TECH_SPEC,
  architecture: TEMPLATE_ARCHITECTURE,
  "workflow-status": TEMPLATE_WORKFLOW_STATUS,
  "sprint-status": TEMPLATE_SPRINT_STATUS,
};

/** Get a template with standard variables substituted. */
export function getTemplate(
  name: TemplateName,
  config: BmadConfig | null,
  extraVars?: Record<string, string>,
): string {
  const template = TEMPLATES[name];
  if (!template) return "";

  const level =
    config?.projectLevel ?? parseInt(extraVars?.project_level || "0", 10);
  const vars: Record<string, string> = {
    project_name: config?.projectName || extraVars?.project_name || "",
    project_type: config?.projectType || extraVars?.project_type || "",
    project_level: String(level),
    user_name: config?.userName || extraVars?.user_name || "Developer",
    output_folder: config?.outputFolder || "docs",
    date: formatDate(),
    timestamp: formatISOTimestamp(),
    version: BMAD_VERSION,
    // Level-based conditional statuses
    prd_status: level >= 2 ? "required" : "recommended",
    tech_spec_status: level <= 1 ? "required" : "optional",
    architecture_status: level >= 2 ? "required" : "optional",
    ...extraVars,
  };

  return substituteVars(template, vars);
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Prompt Builders
// ═══════════════════════════════════════════════════════════════════════════

export function buildContextBlock(
  config: BmadConfig,
  status: WorkflowEntry[],
): string {
  const completed = status.filter((e) => isCompleted(e.status));
  const completedList =
    completed.length > 0
      ? completed.map((e) => `  - ${e.name}: ${e.status}`).join("\n")
      : "  (none yet)";

  return [
    "### Project Context",
    `- **Project:** ${config.projectName} (${config.projectType}, Level ${config.projectLevel})`,
    `- **Output folder:** ${config.outputFolder}`,
    `- **Completed workflows:**`,
    completedList,
  ].join("\n");
}

export function buildToolsBlock(): string {
  return [
    "### Available BMAD Tools",
    "- `bmad_get_template` - Load a pre-populated document template",
    "- `bmad_save_document` - Save the completed document to the output folder",
    "- `bmad_update_status` - Mark this workflow complete in the status tracker",
    "- `bmad_config` - Reload project configuration if needed",
  ].join("\n");
}

export function buildCompletionBlock(workflow: string): string {
  return [
    "### When Complete",
    `1. Save the document using \`bmad_save_document\` with workflow \`${workflow}\``,
    `2. Update status using \`bmad_update_status\` with workflow \`${workflow}\` and the saved file path`,
    "3. Suggest the next recommended workflow to the user",
  ].join("\n");
}

function buildInitPrompt(cwd: string, existing: boolean): string {
  const dirName = basename(cwd);
  const reinitNote = existing
    ? "\n**Note:** This project already has a BMAD configuration. Ask the user if they want to reinitialize (this will overwrite existing config).\n"
    : "";

  return [
    "## BMAD: Initialize Project",
    "",
    `You are the **BMad Master** initializing BMAD Method in this project.${reinitNote}`,
    "",
    "### Process",
    `1. Ask the user for the **project name** (default: "${dirName}")`,
    "2. Ask for **project type**: web-app, mobile-app, api, game, library, or other",
    "3. Ask for **project level** (explain each):",
    ...LEVEL_DEFS.map(
      (l) => `   - **Level ${l.level}**: ${l.label} (${l.stories})`,
    ),
    '4. Get the config template: `bmad_get_template({ template: "config", vars: { project_name, project_type, project_level } })`',
    '5. Save config: `bmad_save_document({ workflow: "config", content: <config>, filename: "bmad/config.yaml" })`',
    '6. Get the workflow status template: `bmad_get_template({ template: "workflow-status", vars: { project_name, project_type, project_level } })`',
    '7. Save status: `bmad_save_document({ workflow: "workflow-status", content: <status>, filename: "docs/bmm-workflow-status.yaml" })`',
    "8. Show the user a summary of what was created and recommend the first workflow:",
    "   - Level 0-1: Start with `/bmad-product-brief` (optional) then `/bmad-tech-spec`",
    "   - Level 2+: Start with `/bmad-product-brief` (recommended) then `/bmad-prd`",
    "",
    buildToolsBlock(),
  ].join("\n");
}

export const WORKFLOW_PROMPTS: Record<
  string,
  (config: BmadConfig, status: WorkflowEntry[]) => string
> = {
  "product-brief": (config, status) =>
    [
      "## BMAD: Product Brief",
      "",
      `You are the **Business Analyst** creating a product brief for **${config.projectName}**.`,
      "Your approach is professional, methodical, and curious.",
      "",
      "### Goal",
      "Create a comprehensive product brief that captures the product vision, problem space, target audience, and business objectives.",
      "",
      "### Process",
      '1. Load the template: `bmad_get_template({ template: "product-brief" })`',
      "2. Interview the user through each section. For each section:",
      "   - Ask focused questions to understand the domain",
      "   - Summarize what you heard and confirm understanding",
      "   - Draft the section content",
      "3. Cover these sections in order:",
      "   - Executive Summary",
      "   - Problem Statement (The Problem, Why Now, Impact)",
      "   - Target Audience (Primary Users, Secondary Users, Needs)",
      "   - Solution Overview (Proposed Solution, Key Features, Value Prop)",
      "   - Business Objectives (Goals, Success Metrics, Business Value)",
      "   - Scope (In Scope, Out of Scope, Future Considerations)",
      "   - Stakeholders",
      "   - Constraints and Assumptions",
      "   - Success Criteria",
      "   - Timeline and Milestones",
      "   - Risks and Mitigation",
      "4. After all sections are complete, compile the full document",
      "5. Present for user review and incorporate feedback",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("product-brief"),
    ].join("\n"),

  brainstorm: (config, status) =>
    [
      "## BMAD: Brainstorming Session",
      "",
      `You are the **Creative Intelligence** facilitating a brainstorming session for **${config.projectName}**.`,
      "",
      "### Goal",
      "Run a structured brainstorming session using proven ideation techniques.",
      "",
      "### Process",
      "1. Ask the user to define the **brainstorming objective** (what problem/opportunity to explore)",
      "2. Select 2-3 techniques from:",
      "   - **5 Whys**: Root cause analysis",
      "   - **SCAMPER**: Substitute, Combine, Adapt, Modify, Put to other uses, Eliminate, Reverse",
      "   - **Mind Mapping**: Central concept with branching associations",
      "   - **Reverse Brainstorming**: How to make the problem worse, then invert",
      "   - **Six Thinking Hats**: Explore from 6 perspectives (facts, emotions, caution, benefits, creativity, process)",
      "   - **Starbursting**: Who, What, When, Where, Why, How questions",
      "3. Execute each technique interactively with the user",
      "4. Organize ideas into themes and categories",
      "5. Extract top insights and actionable items",
      "6. Compile the brainstorming report",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("brainstorm"),
    ].join("\n"),

  research: (config, status) =>
    [
      "## BMAD: Research",
      "",
      `You are the **Creative Intelligence** conducting research for **${config.projectName}**.`,
      "",
      "### Goal",
      "Conduct structured market, competitive, or technical research and deliver an actionable report.",
      "",
      "### Process",
      "1. Define the research scope with the user:",
      "   - Topic and research questions",
      "   - Type: Market, Competitive, Technical, User, or Mixed",
      "   - Constraints and focus areas",
      "2. Select appropriate research methods",
      "3. Gather information (use web search tools when available)",
      "4. Analyze findings and identify patterns",
      "5. Create a competitive matrix if applicable",
      "6. Extract key insights and recommendations",
      "7. Compile the research report with:",
      "   - Executive summary of findings",
      "   - Detailed analysis by research question",
      "   - Competitive landscape",
      "   - Key insights and implications",
      "   - Recommendations for the project",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("research"),
    ].join("\n"),

  prd: (config, status) =>
    [
      "## BMAD: Product Requirements Document",
      "",
      `You are the **Product Manager** creating a PRD for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create a comprehensive PRD with functional requirements, non-functional requirements, epics, and user stories.",
      "",
      "### Process",
      '1. Load the template: `bmad_get_template({ template: "prd" })`',
      "2. Review the product brief if available (check completed workflows)",
      "3. Work through these major sections with the user:",
      "",
      "   **Part 1 - Foundation:**",
      "   - Executive summary and product goals",
      "   - Business objectives with measurable targets",
      "   - Success metrics with baseline and target values",
      "",
      "   **Part 2 - Functional Requirements:**",
      "   - Define requirements in FR-XXX format",
      "   - Assign MoSCoW priority (Must/Should/Could/Won't)",
      "   - Map each FR to an epic",
      "",
      "   **Part 3 - Non-Functional Requirements:**",
      "   - Cover 7 categories: Performance, Security, Scalability, Reliability, Usability, Accessibility, Compliance",
      "   - Use NFR-XXX format with quantitative targets where possible",
      "",
      "   **Part 4 - Epics:**",
      "   - Group related FRs into EPIC-XXX format",
      "   - Include description, priority, and estimated story count",
      "",
      "   **Part 5 - User Stories:**",
      '   - High-level stories in "As a [role], I want [goal], so that [benefit]" format',
      "   - User personas and critical user flows",
      "",
      "   **Part 6 - Supporting Sections:**",
      "   - Dependencies (internal and external)",
      "   - Assumptions, out of scope, open questions",
      "   - Requirements traceability matrix",
      "",
      "4. Compile the complete PRD and present for review",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("prd"),
    ].join("\n"),

  "tech-spec": (config, status) =>
    [
      "## BMAD: Technical Specification",
      "",
      `You are the **Product Manager** creating a tech spec for **${config.projectName}**.`,
      "This is the lightweight planning document for Level 0-1 projects.",
      "",
      "### Goal",
      "Create focused technical planning with clear requirements, approach, and implementation stories.",
      "",
      "### Process",
      '1. Load the template: `bmad_get_template({ template: "tech-spec" })`',
      "2. Review the product brief if available",
      "3. Work through these sections:",
      "   - **Problem & Solution**: Clear problem statement and proposed solution",
      "   - **Requirements**: What needs to be built (numbered list) and exclusions",
      "   - **Technical Approach**: Tech stack, architecture overview, data model, API design",
      "   - **Implementation Plan**: Ordered stories with estimates and dependencies",
      "   - **Acceptance Criteria**: Testable criteria for each feature",
      "   - **NFRs**: Brief performance, security, and operational requirements",
      "   - **Dependencies, Risks, Timeline**",
      "4. Compile and present for review",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("tech-spec"),
    ].join("\n"),

  "create-ux-design": (config, status) =>
    [
      "## BMAD: UX Design",
      "",
      `You are the **UX Designer** creating UX designs for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create user flows, wireframes, component specifications, and design tokens.",
      "",
      "### Process",
      "1. Analyze requirements from PRD/tech-spec (check completed workflows)",
      "2. Identify design scope: which user-facing features need design",
      "3. Create user flows for each critical path",
      "4. Design wireframes using ASCII art or structured descriptions",
      "5. Ensure accessibility (WCAG 2.1 AA compliance)",
      "6. Define reusable UI components with:",
      "   - Component name and purpose",
      "   - Props/variants",
      "   - States (default, hover, active, disabled, error)",
      "   - Accessibility notes",
      "7. Define design tokens (colors, typography, spacing, breakpoints)",
      "8. Create developer handoff notes with implementation guidance",
      "9. Compile the UX design document",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("create-ux-design"),
    ].join("\n"),

  architecture: (config, status) =>
    [
      "## BMAD: System Architecture",
      "",
      `You are the **System Architect** designing the architecture for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create a comprehensive system architecture that satisfies all functional and non-functional requirements.",
      "",
      "### Process",
      '1. Load the template: `bmad_get_template({ template: "architecture" })`',
      "2. Review the PRD for requirements (check completed workflows)",
      "3. Work through these major sections:",
      "",
      "   **Part 1 - Drivers & Overview:**",
      "   - Summarize key FRs and NFRs driving architecture decisions",
      "   - Define the high-level architecture pattern",
      "   - Create an architecture diagram (ASCII or Mermaid)",
      "",
      "   **Part 2 - Technology Stack:**",
      "   - Frontend, Backend, Database, Infrastructure",
      "   - Third-party services and development tools",
      "   - Justify each technology choice",
      "",
      "   **Part 3 - Components & Data:**",
      "   - Define system components with responsibilities and interfaces",
      "   - Data model, database design, and data flow",
      "",
      "   **Part 4 - API & Security:**",
      "   - API architecture and key endpoints",
      "   - Authentication, authorization, encryption",
      "",
      "   **Part 5 - NFR Coverage:**",
      "   - Systematically address each NFR category",
      "   - Performance, security, scalability, reliability strategies",
      "",
      "   **Part 6 - Development & Deployment:**",
      "   - Project structure and coding standards",
      "   - Testing strategy, CI/CD pipeline, environments",
      "   - Monitoring and observability",
      "",
      "   **Part 7 - Decisions & Risks:**",
      "   - Trade-offs and decision log (options considered, chosen, rationale)",
      "   - Architecture-specific risks and mitigation",
      "",
      "4. Present for review and iterate on feedback",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("architecture"),
    ].join("\n"),

  "solutioning-gate-check": (config, status) =>
    [
      "## BMAD: Solutioning Gate Check",
      "",
      `You are the **System Architect** validating the architecture for **${config.projectName}**.`,
      "",
      "### Goal",
      "Validate the architecture against PRD requirements and quality standards. Produce a gate check report.",
      "",
      "### Process",
      "1. Load and parse the PRD and Architecture documents from completed workflows",
      "2. **Validate FR Coverage:**",
      "   - For each functional requirement, verify the architecture addresses it",
      "   - Calculate FR coverage percentage",
      "3. **Validate NFR Coverage:**",
      "   - For each non-functional requirement, verify architectural support",
      "   - Calculate NFR coverage percentage",
      "4. **Architecture Quality Checks:**",
      "   - Single responsibility for each component",
      "   - Clear interfaces between components",
      "   - No circular dependencies",
      "   - Security at every layer",
      "   - Scalability path defined",
      "   - Error handling strategy",
      "   - Monitoring and observability",
      "   - Deployment strategy",
      "   - Data backup and recovery",
      "   - Calculate quality score",
      "5. **Generate Gate Check Report:**",
      "   - **PASS**: FR >= 90%, NFR >= 90%, Quality >= 80%, no blockers",
      "   - **CONDITIONAL PASS**: FR >= 80%, NFR >= 80%, Quality >= 70%",
      "   - **FAIL**: Below conditional thresholds",
      "   - List all gaps with recommendations",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("solutioning-gate-check"),
    ].join("\n"),

  "sprint-planning": (config, status) =>
    [
      "## BMAD: Sprint Planning",
      "",
      `You are the **Scrum Master** planning sprints for **${config.projectName}**.`,
      "",
      "### Goal",
      "Break epics into stories, estimate effort, calculate capacity, and allocate stories to sprints.",
      "",
      "### Process",
      "1. Review epics from PRD or tech-spec (check completed workflows)",
      "2. Break each epic into implementable user stories",
      "3. Estimate story points using Fibonacci scale (1, 2, 3, 5, 8, 13)",
      "4. Ask the user about team capacity:",
      "   - Team size (number of developers)",
      "   - Sprint length (1-4 weeks, default 2)",
      "   - Velocity estimate (story points per sprint)",
      "5. Allocate stories to sprints based on:",
      "   - Dependencies between stories",
      "   - Priority from PRD/tech-spec",
      "   - Team capacity per sprint",
      "6. Define sprint goals (1-2 sentence objective per sprint)",
      "7. Create traceability: Epic -> Stories -> Sprint",
      "8. Identify risks and mitigation for the sprint plan",
      "9. Generate the sprint plan document",
      '10. Initialize sprint status: `bmad_get_template({ template: "sprint-status" })`',
      '11. Save sprint status: `bmad_save_document({ workflow: "sprint-status", content: <status>, filename: "docs/sprint-status.yaml" })`',
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("sprint-planning"),
    ].join("\n"),

  "create-story": (config, status) =>
    [
      "## BMAD: Create User Story",
      "",
      `You are the **Scrum Master** creating a detailed user story for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create a comprehensive, implementation-ready user story document.",
      "",
      "### Process",
      "1. Ask which story to detail (from sprint plan or new)",
      '2. Define the user story in "As a [role], I want [goal], so that [benefit]" format',
      "3. Write a detailed description covering:",
      "   - Background and context",
      "   - User workflow / steps",
      "   - Business rules",
      "4. Define acceptance criteria (Given/When/Then format)",
      "5. Add technical notes:",
      "   - Implementation approach",
      "   - Files/components to modify",
      "   - API changes needed",
      "   - Database changes needed",
      "6. Estimate story points (Fibonacci: 1, 2, 3, 5, 8, 13)",
      "7. List dependencies on other stories",
      '8. Define "Definition of Done" checklist',
      "9. Save to `docs/stories/STORY-{id}.md`",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("create-story"),
    ].join("\n"),

  "dev-story": (config, status) =>
    [
      "## BMAD: Develop Story",
      "",
      `You are the **Developer** implementing a user story for **${config.projectName}**.`,
      "",
      "### Goal",
      "Implement a user story end-to-end following TDD and best practices.",
      "",
      "### Process",
      "1. Ask which story to implement (or read from `docs/stories/`)",
      "2. Review the story document thoroughly:",
      "   - Acceptance criteria",
      "   - Technical notes",
      "   - Dependencies",
      "3. Plan implementation tasks (use TodoWrite to track)",
      "4. Set up environment:",
      "   - Create a feature branch: `git checkout -b feature/STORY-{id}`",
      "   - Verify dev environment is working",
      "5. Implement following TDD:",
      "   - **Red**: Write failing tests for acceptance criteria",
      "   - **Green**: Write minimal code to pass tests",
      "   - **Refactor**: Clean up while keeping tests green",
      "6. Implementation order:",
      "   - Data layer (models, migrations, repositories)",
      "   - Business logic (services, validation)",
      "   - API endpoints (routes, controllers, middleware)",
      "   - Frontend (components, state, integration)",
      "7. Run all tests and fix any failures",
      "8. Manual testing against acceptance criteria",
      "9. Validate all acceptance criteria are met",
      "10. Commit with a descriptive message",
      "",
      buildContextBlock(config, status),
      "",
      "### Note",
      "This workflow drives actual code implementation. Use all standard development tools",
      "(file read/write, terminal, etc.) in addition to BMAD tools for status tracking.",
      "",
      buildCompletionBlock("dev-story"),
    ].join("\n"),

  "create-agent": (config, status) =>
    [
      "## BMAD: Create Agent",
      "",
      `You are the **Builder** creating a custom agent for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create a specialized agent skill file that can be used in BMAD workflows.",
      "",
      "### Process",
      "1. Gather requirements from the user:",
      "   - Agent role and name",
      "   - Domain or phase the agent operates in",
      "   - Key responsibilities",
      "2. Define core principles (3-5 guiding principles for the agent)",
      "3. Define workflows the agent can execute",
      "4. Specify integration points with other BMAD agents",
      "5. Add domain-specific guidance and constraints",
      "6. Generate the agent skill file",
      "7. Validate the agent definition is complete and consistent",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("create-agent"),
    ].join("\n"),

  "create-workflow": (config, status) =>
    [
      "## BMAD: Create Workflow",
      "",
      `You are the **Builder** creating a custom workflow for **${config.projectName}**.`,
      "",
      "### Goal",
      "Create a reusable workflow command that follows BMAD patterns.",
      "",
      "### Process",
      "1. Define the workflow with the user:",
      "   - Name and purpose",
      "   - Which agent executes it",
      "   - Inputs required and outputs produced",
      "   - Estimated duration",
      "2. Design the step-by-step process",
      "3. Define the command prompt structure",
      "4. Generate the workflow definition file",
      "5. Validate and save",
      "",
      buildContextBlock(config, status),
      "",
      buildToolsBlock(),
      "",
      buildCompletionBlock("create-workflow"),
    ].join("\n"),
};

// ═══════════════════════════════════════════════════════════════════════════
// Tool Schemas
// ═══════════════════════════════════════════════════════════════════════════

const ConfigParams = Type.Object({});

const UpdateStatusParams = Type.Object({
  workflow: Type.String({
    description:
      "Workflow name to mark complete (e.g., 'product-brief', 'prd', 'architecture')",
  }),
  filePath: Type.String({
    description:
      "Path to the completed document, relative to project root (e.g., 'docs/prd-myapp-2026-02-11.md')",
  }),
});
type UpdateStatusInput = Static<typeof UpdateStatusParams>;

const SaveDocumentParams = Type.Object({
  workflow: Type.String({
    description:
      "Workflow name for auto-path generation (e.g., 'product-brief', 'prd')",
  }),
  content: Type.String({
    description: "Document content to save",
  }),
  filename: Type.Optional(
    Type.String({
      description:
        "Custom filename/path relative to project root. If omitted, auto-generates: {output_folder}/{workflow}-{project_name}-{date}.md",
    }),
  ),
});
type SaveDocumentInput = Static<typeof SaveDocumentParams>;

const GetTemplateParams = Type.Object({
  template: StringEnum(TEMPLATE_NAMES, {
    description:
      "Template to retrieve: config, product-brief, prd, tech-spec, architecture, workflow-status, sprint-status",
  }),
  vars: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Additional variables for substitution (e.g., project_name, project_type, project_level during init)",
    }),
  ),
});
type GetTemplateInput = Static<typeof GetTemplateParams>;

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  let cwd = "";

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;

    // Detect BMAD project
    const config = await loadConfig(cwd);
    if (config) {
      const levelDef = LEVEL_DEFS[config.projectLevel] || LEVEL_DEFS[0];
      ctx.ui.setStatus(
        "bmad",
        `bmad: L${config.projectLevel} ${config.projectName}`,
      );

      // Load status and show recommendation
      const status = await loadStatus(cwd, config);
      if (status.length > 0) {
        const next = getNextRecommendation(status, config.projectLevel);
        pi.sendMessage(
          {
            customType: "bmad-session-start",
            content: `**BMAD** ${config.projectName} (${config.projectType}, Level ${config.projectLevel} - ${levelDef.label})\nNext recommended: \`/bmad-${next}\``,
            display: true,
          },
          { triggerTurn: false },
        );
      }
    }
  });

  // --- Tool: bmad_config ---

  pi.registerTool({
    name: "bmad_config",
    label: "BMAD Config",
    description:
      "Load the merged BMAD project configuration (global + project). " +
      "Returns project name, type, level, paths, and status file locations.",
    parameters: ConfigParams,

    async execute() {
      const config = await loadConfig(cwd);
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: "BMAD not initialized in this project. Run /bmad-init first.",
            },
          ],
          details: {},
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `Project: ${config.projectName}`,
              `Type: ${config.projectType}`,
              `Level: ${config.projectLevel}`,
              `Output folder: ${config.outputFolder}`,
              `Status file: ${config.workflowStatusFile}`,
              `Sprint file: ${config.sprintStatusFile}`,
              `Docs: ${config.paths.docs}`,
              `Stories: ${config.paths.stories}`,
              `Tests: ${config.paths.tests}`,
            ].join("\n"),
          },
        ],
        details: config as unknown as Record<string, unknown>,
      };
    },
  });

  // --- Tool: bmad_update_status ---

  pi.registerTool({
    name: "bmad_update_status",
    label: "BMAD Update Status",
    description:
      "Mark a BMAD workflow as complete in the workflow status tracker. " +
      "Updates the workflow's status from its current value to the path of the completed document.",
    parameters: UpdateStatusParams,

    async execute(_toolCallId, params: UpdateStatusInput) {
      const config = await loadConfig(cwd);
      if (!config) {
        return {
          content: [{ type: "text", text: "BMAD not initialized." }],
          details: {},
        };
      }

      const statusPath = join(cwd, config.workflowStatusFile);
      let content: string;
      try {
        content = await readFile(statusPath, "utf-8");
      } catch {
        return {
          content: [
            {
              type: "text",
              text: `Status file not found: ${config.workflowStatusFile}`,
            },
          ],
          details: {},
        };
      }

      const timestamp = formatISOTimestamp();
      const updated = updateStatusInYaml(
        content,
        params.workflow,
        params.filePath,
        timestamp,
      );

      try {
        await writeFile(statusPath, updated, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `Updated workflow '${params.workflow}' status to: ${params.filePath}`,
            },
          ],
          details: { workflow: params.workflow, filePath: params.filePath },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error writing status: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // --- Tool: bmad_save_document ---

  pi.registerTool({
    name: "bmad_save_document",
    label: "BMAD Save Document",
    description:
      "Save a BMAD document to the project. If no filename is provided, " +
      "auto-generates a path as {output_folder}/{workflow}-{project_name}-{date}.md",
    parameters: SaveDocumentParams,

    async execute(_toolCallId, params: SaveDocumentInput) {
      const config = await loadConfig(cwd);
      let outputPath: string;

      if (params.filename) {
        outputPath = join(cwd, params.filename);
      } else {
        const projectSlug = config ? slugify(config.projectName) : "project";
        const folder = config?.outputFolder || "docs";
        const filename = `${params.workflow}-${projectSlug}-${formatDate()}.md`;
        outputPath = join(cwd, folder, filename);
      }

      // Ensure parent directory exists
      const parentDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
      try {
        await mkdir(parentDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      try {
        await writeFile(outputPath, params.content, "utf-8");
        // Return path relative to cwd
        const relativePath = outputPath.startsWith(cwd + "/")
          ? outputPath.slice(cwd.length + 1)
          : outputPath;

        return {
          content: [
            {
              type: "text",
              text: `Document saved to: ${relativePath}`,
            },
          ],
          details: { path: relativePath },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Error saving document: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // --- Tool: bmad_get_template ---

  pi.registerTool({
    name: "bmad_get_template",
    label: "BMAD Get Template",
    description:
      "Get a BMAD template with standard variables substituted. " +
      "Returns the template content with project name, date, level, etc. pre-filled. " +
      "Pass additional vars for templates that need them (e.g., during init).",
    parameters: GetTemplateParams,

    async execute(_toolCallId, params: GetTemplateInput) {
      const config = await loadConfig(cwd);
      const templateName = params.template as TemplateName;

      if (!TEMPLATES[templateName]) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown template: ${params.template}. Available: ${TEMPLATE_NAMES.join(", ")}`,
            },
          ],
          details: {},
        };
      }

      const content = getTemplate(templateName, config, params.vars);

      return {
        content: [{ type: "text", text: content }],
        details: { template: templateName },
      };
    },
  });

  // --- Command: /bmad-init ---

  pi.registerCommand("bmad-init", {
    description: "Initialize BMAD Method in the current project",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;

      let existing = false;
      try {
        await readFile(join(cwd, "bmad", "config.yaml"), "utf-8");
        existing = true;
      } catch {
        // Not initialized yet
      }

      // Create directory structure
      await mkdir(join(cwd, "bmad"), { recursive: true });
      await mkdir(join(cwd, "docs", "stories"), { recursive: true });

      ctx.ui.notify(
        existing
          ? "BMAD project detected. Sending init prompt..."
          : "Creating BMAD project structure...",
        "info",
      );

      pi.sendUserMessage(buildInitPrompt(cwd, existing));
    },
  });

  // --- Command: /bmad-status ---

  pi.registerCommand("bmad-status", {
    description: "Show BMAD workflow progress and recommendations",
    handler: async (_args, ctx) => {
      cwd = ctx.cwd;

      const config = await loadConfig(cwd);
      if (!config) {
        ctx.ui.notify("BMAD not initialized. Run /bmad-init first.", "warning");
        return;
      }

      const status = await loadStatus(cwd, config);
      const levelDef = LEVEL_DEFS[config.projectLevel] || LEVEL_DEFS[0];
      const recommendation = getNextRecommendation(status, config.projectLevel);

      const lines: string[] = [
        `**BMAD Project Status: ${config.projectName}**`,
        `Level: ${config.projectLevel} - ${levelDef.label} (${levelDef.stories})`,
        `Type: ${config.projectType}`,
        "",
      ];

      // Group entries by phase
      for (const phase of PHASES) {
        const phaseEntries = status.filter((e) => e.phase === phase.phase);
        if (phaseEntries.length === 0) continue;

        const req = phase.required ? "Required" : "Optional";
        lines.push(`**Phase ${phase.phase} - ${phase.name}** (${req})`);

        for (const entry of phaseEntries) {
          const symbol = formatStatusSymbol(entry, recommendation);
          const statusText = isCompleted(entry.status)
            ? entry.status
            : entry.status;
          lines.push(
            `  ${symbol} ${entry.name} (${statusText}) - ${entry.description}`,
          );
        }
        lines.push("");
      }

      // Phase 4 note
      lines.push("**Phase 4 - Implementation** (Required)");
      lines.push(`  Sprint status: ${config.sprintStatusFile}`);
      lines.push("");

      // Recommendation
      lines.push(`**Recommendation:** Run \`/bmad-${recommendation}\``);

      pi.sendMessage(
        {
          customType: "bmad-status",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // --- Workflow Commands (13 workflows) ---

  for (const def of WORKFLOW_DEFS) {
    pi.registerCommand(`bmad-${def.name}`, {
      description: `${def.description} (${def.agent})`,
      handler: async (_args, ctx) => {
        cwd = ctx.cwd;

        const config = await loadConfig(cwd);
        if (!config) {
          ctx.ui.notify(
            "BMAD not initialized. Run /bmad-init first.",
            "warning",
          );
          return;
        }

        const status = await loadStatus(cwd, config);
        const promptBuilder = WORKFLOW_PROMPTS[def.name];

        if (!promptBuilder) {
          ctx.ui.notify(`No prompt defined for workflow: ${def.name}`, "error");
          return;
        }

        ctx.ui.notify(
          `Starting ${def.name} workflow (${def.agent})...`,
          "info",
        );
        pi.sendUserMessage(promptBuilder(config, status));
      },
    });
  }
}
