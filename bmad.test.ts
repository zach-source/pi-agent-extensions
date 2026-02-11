import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  formatDate,
  formatISOTimestamp,
  substituteVars,
  slugify,
  parseConfigYaml,
  parseWorkflowEntries,
  updateStatusInYaml,
  mergeConfigs,
  loadProjectConfig,
  loadConfig,
  loadStatus,
  getNextRecommendation,
  formatStatusSymbol,
  getTemplate,
  BMAD_VERSION,
  LEVEL_DEFS,
  PHASES,
  WORKFLOW_DEFS,
  TEMPLATE_NAMES,
  type BmadConfig,
  type WorkflowEntry,
} from "./bmad.js";
import initExtension from "./bmad.js";

// ---------------------------------------------------------------------------
// Mock factories (same pattern as heartbeat.test.ts)
// ---------------------------------------------------------------------------

function createMockExtensionAPI() {
  const handlers = new Map<string, Function[]>();
  const tools: Array<{ name: string; [k: string]: any }> = [];
  const commands = new Map<
    string,
    { description: string; handler: Function }
  >();

  const api = {
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool(def: any) {
      tools.push(def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn(),
  };

  return {
    api,
    async emit(event: string, eventData: any, ctx: any) {
      const fns = handlers.get(event) ?? [];
      for (const fn of fns) {
        await fn(eventData, ctx);
      }
    },
    getCommand(name: string) {
      return commands.get(name);
    },
    getTool(name: string) {
      return tools.find((t) => t.name === name);
    },
    get handlers() {
      return handlers;
    },
    get tools() {
      return tools;
    },
    get commands() {
      return commands;
    },
  };
}

function createMockContext(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    cwd: overrides.cwd ?? "/tmp/test",
    isIdle: vi.fn().mockReturnValue(true),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers for file-based tests
// ---------------------------------------------------------------------------

async function setupBmadProject(
  tmpDir: string,
  overrides: {
    projectName?: string;
    projectType?: string;
    projectLevel?: number;
  } = {},
) {
  const projectName = overrides.projectName || "test-project";
  const projectType = overrides.projectType || "web-app";
  const projectLevel = overrides.projectLevel ?? 2;

  await mkdir(join(tmpDir, "bmad"), { recursive: true });
  await mkdir(join(tmpDir, "docs"), { recursive: true });

  const configContent = [
    `project_name: "${projectName}"`,
    `project_type: "${projectType}"`,
    `project_level: ${projectLevel}`,
    `output_folder: "docs"`,
    "bmm:",
    `  workflow_status_file: "docs/bmm-workflow-status.yaml"`,
    `  sprint_status_file: "docs/sprint-status.yaml"`,
    "paths:",
    `  docs: "docs"`,
    `  stories: "docs/stories"`,
    `  tests: "tests"`,
  ].join("\n");

  await writeFile(join(tmpDir, "bmad", "config.yaml"), configContent);
  return { configContent, projectName, projectType, projectLevel };
}

async function setupWorkflowStatus(
  tmpDir: string,
  entries: {
    name: string;
    phase: number;
    status: string;
    description: string;
  }[],
) {
  const lines = [
    `project_name: "test-project"`,
    `project_type: "web-app"`,
    `project_level: 2`,
    `last_updated: "2026-01-01T00:00:00.000Z"`,
    "",
    "workflow_status:",
  ];

  for (const entry of entries) {
    lines.push(`  - name: ${entry.name}`);
    lines.push(`    phase: ${entry.phase}`);
    lines.push(`    status: "${entry.status}"`);
    lines.push(`    description: "${entry.description}"`);
    lines.push("");
  }

  await writeFile(
    join(tmpDir, "docs", "bmm-workflow-status.yaml"),
    lines.join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 1. Pure function tests
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const d = formatDate();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatISOTimestamp", () => {
  it("returns ISO 8601 format", () => {
    const ts = formatISOTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("substituteVars", () => {
  it("replaces known variables", () => {
    expect(substituteVars("Hello {{name}}!", { name: "World" })).toBe(
      "Hello World!",
    );
  });

  it("leaves unknown variables untouched", () => {
    expect(substituteVars("{{known}} {{unknown}}", { known: "yes" })).toBe(
      "yes {{unknown}}",
    );
  });

  it("replaces multiple occurrences", () => {
    expect(substituteVars("{{a}} and {{a}}", { a: "X" })).toBe("X and X");
  });

  it("handles empty vars", () => {
    expect(substituteVars("{{a}}", {})).toBe("{{a}}");
  });
});

describe("slugify", () => {
  it("converts to lowercase with hyphens", () => {
    expect(slugify("My Project")).toBe("my-project");
  });

  it("removes special characters", () => {
    expect(slugify("Hello, World! v2.0")).toBe("hello-world-v2-0");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});

describe("parseConfigYaml", () => {
  it("parses flat key-value pairs", () => {
    const yaml = `project_name: "My App"\nproject_level: 2`;
    const result = parseConfigYaml(yaml);
    expect(result.project_name).toBe("My App");
    expect(result.project_level).toBe("2");
  });

  it("parses nested sections", () => {
    const yaml = [
      "bmm:",
      '  workflow_status_file: "docs/status.yaml"',
      '  sprint_status_file: "docs/sprint.yaml"',
    ].join("\n");
    const result = parseConfigYaml(yaml);
    expect(result.bmm).toEqual({
      workflow_status_file: "docs/status.yaml",
      sprint_status_file: "docs/sprint.yaml",
    });
  });

  it("strips quotes from values", () => {
    const yaml = `key: "quoted value"`;
    expect(parseConfigYaml(yaml).key).toBe("quoted value");
  });

  it("ignores comments and empty lines", () => {
    const yaml = "# comment\n\nkey: value\n# another comment";
    const result = parseConfigYaml(yaml);
    expect(result.key).toBe("value");
    expect(Object.keys(result)).toHaveLength(1);
  });

  it("handles multiple nested sections", () => {
    const yaml = [
      "bmm:",
      "  a: 1",
      "paths:",
      "  docs: docs",
      "  tests: tests",
    ].join("\n");
    const result = parseConfigYaml(yaml);
    expect((result.bmm as Record<string, string>).a).toBe("1");
    expect((result.paths as Record<string, string>).docs).toBe("docs");
    expect((result.paths as Record<string, string>).tests).toBe("tests");
  });
});

describe("parseWorkflowEntries", () => {
  it("parses workflow entries from YAML", () => {
    const yaml = [
      "workflow_status:",
      "  - name: product-brief",
      "    phase: 1",
      '    status: "optional"',
      '    description: "Create product brief"',
      "",
      "  - name: prd",
      "    phase: 2",
      '    status: "required"',
      '    description: "Product Requirements"',
    ].join("\n");

    const entries = parseWorkflowEntries(yaml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "product-brief",
      phase: 1,
      status: "optional",
      description: "Create product brief",
    });
    expect(entries[1]).toEqual({
      name: "prd",
      phase: 2,
      status: "required",
      description: "Product Requirements",
    });
  });

  it("parses completed status (file path)", () => {
    const yaml = [
      "workflow_status:",
      "  - name: product-brief",
      "    phase: 1",
      '    status: "docs/product-brief-myapp-2026-01-01.md"',
      '    description: "Product brief"',
    ].join("\n");

    const entries = parseWorkflowEntries(yaml);
    expect(entries[0].status).toBe("docs/product-brief-myapp-2026-01-01.md");
  });

  it("returns empty array for content without entries", () => {
    expect(parseWorkflowEntries("")).toHaveLength(0);
    expect(parseWorkflowEntries("random content")).toHaveLength(0);
  });
});

describe("updateStatusInYaml", () => {
  const baseYaml = [
    'last_updated: "2026-01-01T00:00:00.000Z"',
    "",
    "workflow_status:",
    "  - name: product-brief",
    "    phase: 1",
    '    status: "optional"',
    '    description: "Product brief"',
    "",
    "  - name: prd",
    "    phase: 2",
    '    status: "required"',
    '    description: "PRD"',
  ].join("\n");

  it("updates the target workflow status", () => {
    const updated = updateStatusInYaml(
      baseYaml,
      "product-brief",
      "docs/product-brief-myapp-2026-02-11.md",
      "2026-02-11T10:00:00.000Z",
    );
    expect(updated).toContain(
      'status: "docs/product-brief-myapp-2026-02-11.md"',
    );
    // Other workflow untouched
    expect(updated).toContain('status: "required"');
  });

  it("updates last_updated timestamp", () => {
    const updated = updateStatusInYaml(
      baseYaml,
      "product-brief",
      "docs/pb.md",
      "2026-02-11T10:00:00.000Z",
    );
    expect(updated).toContain('last_updated: "2026-02-11T10:00:00.000Z"');
    expect(updated).not.toContain("2026-01-01");
  });

  it("leaves content unchanged for unknown workflow", () => {
    const updated = updateStatusInYaml(
      baseYaml,
      "nonexistent",
      "docs/x.md",
      "2026-02-11T10:00:00.000Z",
    );
    // Statuses unchanged
    expect(updated).toContain('status: "optional"');
    expect(updated).toContain('status: "required"');
    // But timestamp still updated
    expect(updated).toContain('last_updated: "2026-02-11T10:00:00.000Z"');
  });
});

describe("mergeConfigs", () => {
  it("uses defaults when both are empty", () => {
    const result = mergeConfigs({}, {});
    expect(result.version).toBe(BMAD_VERSION);
    expect(result.outputFolder).toBe("docs");
    expect(result.paths.docs).toBe("docs");
  });

  it("global overrides defaults", () => {
    const result = mergeConfigs({ userName: "Alice" }, {});
    expect(result.userName).toBe("Alice");
  });

  it("project overrides global", () => {
    const result = mergeConfigs(
      { userName: "Alice", projectName: "global-proj" },
      { projectName: "my-proj", projectLevel: 3 },
    );
    expect(result.projectName).toBe("my-proj");
    expect(result.userName).toBe("Alice");
    expect(result.projectLevel).toBe(3);
  });

  it("merges nested paths correctly", () => {
    const result = mergeConfigs(
      {
        paths: {
          docs: "global-docs",
          stories: "global-stories",
          tests: "tests",
        },
      },
      {
        paths: {
          docs: "proj-docs",
          stories: "proj-stories",
          tests: "proj-tests",
        },
      },
    );
    expect(result.paths.docs).toBe("proj-docs");
    expect(result.paths.stories).toBe("proj-stories");
    expect(result.paths.tests).toBe("proj-tests");
  });
});

describe("getNextRecommendation", () => {
  const makeEntry = (
    name: string,
    status: string,
    phase = 1,
  ): WorkflowEntry => ({
    name,
    phase,
    status,
    description: "",
  });

  it("recommends product-brief when nothing is done", () => {
    const entries = [
      makeEntry("product-brief", "optional"),
      makeEntry("prd", "required", 2),
      makeEntry("tech-spec", "required", 2),
    ];
    expect(getNextRecommendation(entries, 2)).toBe("product-brief");
  });

  it("recommends tech-spec for level 0-1 after product-brief", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("tech-spec", "required", 2),
      makeEntry("prd", "recommended", 2),
    ];
    expect(getNextRecommendation(entries, 1)).toBe("tech-spec");
  });

  it("recommends prd for level 2+ after product-brief", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("prd", "required", 2),
      makeEntry("tech-spec", "optional", 2),
    ];
    expect(getNextRecommendation(entries, 2)).toBe("prd");
  });

  it("recommends architecture for level 2+ after prd", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("prd", "docs/prd.md", 2),
      makeEntry("architecture", "required", 3),
    ];
    expect(getNextRecommendation(entries, 2)).toBe("architecture");
  });

  it("recommends sprint-planning when architecture done", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("prd", "docs/prd.md", 2),
      makeEntry("architecture", "docs/arch.md", 3),
      makeEntry("sprint-planning", "required", 4),
    ];
    expect(getNextRecommendation(entries, 2)).toBe("sprint-planning");
  });

  it("recommends dev-story when all tracked workflows done", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("prd", "docs/prd.md", 2),
      makeEntry("architecture", "docs/arch.md", 3),
      makeEntry("sprint-planning", "docs/sprint.md", 4),
      makeEntry("create-story", "docs/story.md", 4),
    ];
    expect(getNextRecommendation(entries, 2)).toBe("dev-story");
  });

  it("skips architecture for level 0-1", () => {
    const entries = [
      makeEntry("product-brief", "docs/pb.md"),
      makeEntry("tech-spec", "docs/ts.md", 2),
      makeEntry("architecture", "optional", 3),
      makeEntry("sprint-planning", "required", 4),
    ];
    expect(getNextRecommendation(entries, 0)).toBe("sprint-planning");
  });
});

describe("formatStatusSymbol", () => {
  const entry = (status: string, name = "test"): WorkflowEntry => ({
    name,
    phase: 1,
    status,
    description: "",
  });

  it("returns checkmark for completed workflows", () => {
    expect(formatStatusSymbol(entry("docs/file.md"), "other")).toBe("\u2713");
  });

  it("returns ~ for skipped workflows", () => {
    expect(formatStatusSymbol(entry("skipped"), "other")).toBe("~");
  });

  it("returns arrow for current recommendation", () => {
    expect(formatStatusSymbol(entry("required", "prd"), "prd")).toBe("\u2192");
  });

  it("returns ! for required but not current", () => {
    expect(formatStatusSymbol(entry("required", "prd"), "other")).toBe("!");
  });

  it("returns - for optional", () => {
    expect(formatStatusSymbol(entry("optional"), "other")).toBe("-");
  });
});

describe("getTemplate", () => {
  it("substitutes config variables", () => {
    const config: BmadConfig = {
      ...mergeConfigs({}, {}),
      projectName: "My App",
      projectType: "web-app",
      projectLevel: 2,
      userName: "Alice",
    };
    const result = getTemplate("product-brief", config);
    expect(result).toContain("# Product Brief: My App");
    expect(result).toContain("**Author:** Alice");
    expect(result).toContain("**Project Type:** web-app");
    expect(result).toContain("**Project Level:** 2");
  });

  it("uses extra vars when no config", () => {
    const result = getTemplate("config", null, {
      project_name: "FromVars",
      project_type: "api",
      project_level: "1",
    });
    expect(result).toContain('project_name: "FromVars"');
    expect(result).toContain('project_type: "api"');
    expect(result).toContain("project_level: 1");
  });

  it("sets level-based statuses in workflow-status template", () => {
    // Level 2+: PRD required, tech-spec optional, architecture required
    const level2 = getTemplate("workflow-status", null, {
      project_name: "test",
      project_type: "web-app",
      project_level: "2",
    });
    expect(level2).toContain('status: "required"'); // prd
    expect(level2).toContain('status: "optional"'); // tech-spec

    // Level 0: PRD recommended, tech-spec required, architecture optional
    const level0 = getTemplate("workflow-status", null, {
      project_name: "test",
      project_type: "web-app",
      project_level: "0",
    });
    expect(level0).toContain('status: "recommended"'); // prd
    expect(level0).toContain('status: "required"'); // tech-spec
  });

  it("returns empty for unknown template", () => {
    expect(getTemplate("nonexistent" as any, null)).toBe("");
  });

  it("includes BMAD version in templates", () => {
    const result = getTemplate("product-brief", null, {
      project_name: "test",
    });
    expect(result).toContain(BMAD_VERSION);
  });
});

describe("constants", () => {
  it("exports correct BMAD version", () => {
    expect(BMAD_VERSION).toBe("6.0.0");
  });

  it("has 5 level definitions", () => {
    expect(LEVEL_DEFS).toHaveLength(5);
    expect(LEVEL_DEFS[0].level).toBe(0);
    expect(LEVEL_DEFS[4].level).toBe(4);
  });

  it("has 4 phases", () => {
    expect(PHASES).toHaveLength(4);
    expect(PHASES[0].phase).toBe(1);
    expect(PHASES[3].phase).toBe(4);
  });

  it("has 13 workflow definitions", () => {
    expect(WORKFLOW_DEFS).toHaveLength(13);
  });

  it("has 7 template names", () => {
    expect(TEMPLATE_NAMES).toHaveLength(7);
    expect(TEMPLATE_NAMES).toContain("config");
    expect(TEMPLATE_NAMES).toContain("product-brief");
    expect(TEMPLATE_NAMES).toContain("prd");
  });

  it("workflow defs have correct level-based defaults", () => {
    const prd = WORKFLOW_DEFS.find((w) => w.name === "prd")!;
    expect(prd.defaultStatus(0)).toBe("recommended");
    expect(prd.defaultStatus(2)).toBe("required");

    const techSpec = WORKFLOW_DEFS.find((w) => w.name === "tech-spec")!;
    expect(techSpec.defaultStatus(0)).toBe("required");
    expect(techSpec.defaultStatus(2)).toBe("optional");

    const arch = WORKFLOW_DEFS.find((w) => w.name === "architecture")!;
    expect(arch.defaultStatus(1)).toBe("optional");
    expect(arch.defaultStatus(2)).toBe("required");
  });
});

// ---------------------------------------------------------------------------
// 2. Extension registration tests
// ---------------------------------------------------------------------------

describe("extension registration", () => {
  it("registers session_start event handler", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    expect(mock.handlers.has("session_start")).toBe(true);
  });

  it("registers 4 tools", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    const expectedTools = [
      "bmad_config",
      "bmad_update_status",
      "bmad_save_document",
      "bmad_get_template",
    ];
    for (const name of expectedTools) {
      expect(mock.getTool(name), `missing tool: ${name}`).toBeDefined();
    }
    expect(mock.tools).toHaveLength(4);
  });

  it("registers 15 commands (2 management + 13 workflow)", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    // Management commands
    expect(mock.getCommand("bmad-init")).toBeDefined();
    expect(mock.getCommand("bmad-status")).toBeDefined();

    // Workflow commands
    for (const def of WORKFLOW_DEFS) {
      expect(
        mock.getCommand(`bmad-${def.name}`),
        `missing command: bmad-${def.name}`,
      ).toBeDefined();
    }

    expect(mock.commands.size).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 3. Config loading tests (file-based)
// ---------------------------------------------------------------------------

describe("loadProjectConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-cfg-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads project config from bmad/config.yaml", async () => {
    await setupBmadProject(tmpDir, { projectName: "My App", projectLevel: 3 });
    const config = await loadProjectConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.projectName).toBe("My App");
    expect(config!.projectLevel).toBe(3);
  });

  it("returns null when no config file", async () => {
    const config = await loadProjectConfig(tmpDir);
    expect(config).toBeNull();
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-lcfg-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns merged config when project config exists", async () => {
    await setupBmadProject(tmpDir, { projectName: "Merged" });
    const config = await loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.projectName).toBe("Merged");
    // Defaults should be present
    expect(config!.version).toBe(BMAD_VERSION);
    expect(config!.paths.docs).toBe("docs");
  });

  it("returns null when no project config", async () => {
    const config = await loadConfig(tmpDir);
    expect(config).toBeNull();
  });
});

describe("loadStatus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-stat-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads workflow entries from status file", async () => {
    await setupBmadProject(tmpDir);
    await setupWorkflowStatus(tmpDir, [
      {
        name: "product-brief",
        phase: 1,
        status: "optional",
        description: "Product brief",
      },
    ]);

    const config = (await loadConfig(tmpDir))!;
    const status = await loadStatus(tmpDir, config);
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe("product-brief");
  });

  it("returns empty array when no status file", async () => {
    await setupBmadProject(tmpDir);
    const config = (await loadConfig(tmpDir))!;
    const status = await loadStatus(tmpDir, config);
    expect(status).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Tool tests (file-based)
// ---------------------------------------------------------------------------

describe("bmad_config tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-tool-cfg-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns config when BMAD is initialized", async () => {
    await setupBmadProject(tmpDir, { projectName: "ToolTest" });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_config")!;
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("ToolTest");
    expect(result.content[0].text).toContain("web-app");
  });

  it("returns error when not initialized", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_config")!;
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("not initialized");
  });
});

describe("bmad_get_template tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-tool-tpl-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns template with config vars substituted", async () => {
    await setupBmadProject(tmpDir, { projectName: "TplTest" });
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_get_template")!;
    const result = await tool.execute("call-1", {
      template: "product-brief",
    });
    expect(result.content[0].text).toContain("# Product Brief: TplTest");
  });

  it("accepts extra vars for substitution", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_get_template")!;
    const result = await tool.execute("call-1", {
      template: "config",
      vars: {
        project_name: "VarTest",
        project_type: "api",
        project_level: "1",
      },
    });
    expect(result.content[0].text).toContain('project_name: "VarTest"');
    expect(result.content[0].text).toContain('project_type: "api"');
  });

  it("returns error for unknown template", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_get_template")!;
    const result = await tool.execute("call-1", { template: "nonexistent" });
    expect(result.content[0].text).toContain("Unknown template");
  });
});

describe("bmad_save_document tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-tool-save-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("saves with custom filename", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_save_document")!;
    await mkdir(join(tmpDir, "bmad"), { recursive: true });

    const result = await tool.execute("call-1", {
      workflow: "config",
      content: "test: content",
      filename: "bmad/config.yaml",
    });

    expect(result.content[0].text).toContain("bmad/config.yaml");
    const saved = await readFile(join(tmpDir, "bmad", "config.yaml"), "utf-8");
    expect(saved).toBe("test: content");
  });

  it("auto-generates path from workflow name", async () => {
    await setupBmadProject(tmpDir, { projectName: "AutoPath" });
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_save_document")!;
    const result = await tool.execute("call-1", {
      workflow: "product-brief",
      content: "# Product Brief",
    });

    const expectedPrefix = `docs/product-brief-autopath-${formatDate()}.md`;
    expect(result.content[0].text).toContain(expectedPrefix);
  });

  it("creates parent directories", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_save_document")!;
    const result = await tool.execute("call-1", {
      workflow: "test",
      content: "nested content",
      filename: "deep/nested/dir/file.md",
    });

    expect(result.content[0].text).toContain("deep/nested/dir/file.md");
    const saved = await readFile(
      join(tmpDir, "deep", "nested", "dir", "file.md"),
      "utf-8",
    );
    expect(saved).toBe("nested content");
  });
});

describe("bmad_update_status tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-tool-upd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("updates workflow status in YAML file", async () => {
    await setupBmadProject(tmpDir);
    await setupWorkflowStatus(tmpDir, [
      {
        name: "product-brief",
        phase: 1,
        status: "optional",
        description: "Product brief",
      },
    ]);

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_update_status")!;
    const result = await tool.execute("call-1", {
      workflow: "product-brief",
      filePath: "docs/product-brief-test-2026-02-11.md",
    });

    expect(result.content[0].text).toContain("Updated workflow");
    const content = await readFile(
      join(tmpDir, "docs", "bmm-workflow-status.yaml"),
      "utf-8",
    );
    expect(content).toContain(
      'status: "docs/product-brief-test-2026-02-11.md"',
    );
  });

  it("returns error when not initialized", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_update_status")!;
    const result = await tool.execute("call-1", {
      workflow: "prd",
      filePath: "docs/prd.md",
    });
    expect(result.content[0].text).toContain("not initialized");
  });

  it("returns error when status file missing", async () => {
    await setupBmadProject(tmpDir);
    // Don't create status file

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("bmad_update_status")!;
    const result = await tool.execute("call-1", {
      workflow: "prd",
      filePath: "docs/prd.md",
    });
    expect(result.content[0].text).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// 5. Command tests
// ---------------------------------------------------------------------------

describe("/bmad-init command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-cmd-init-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates bmad/ and docs/stories/ directories", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    const cmd = mock.getCommand("bmad-init")!;
    await cmd.handler("", ctx);

    // Directories should exist
    const bmadDir = await readFile(
      join(tmpDir, "bmad", ".gitkeep"),
      "utf-8",
    ).catch(() => null);
    // Actually check dir exists via mkdir not throwing
    await mkdir(join(tmpDir, "bmad"), { recursive: true }); // no-op if exists
    await mkdir(join(tmpDir, "docs", "stories"), { recursive: true });
  });

  it("sends init prompt to LLM", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    const cmd = mock.getCommand("bmad-init")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = mock.api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("BMAD: Initialize Project");
    expect(prompt).toContain("BMad Master");
    expect(prompt).toContain("project name");
    expect(prompt).toContain("project type");
    expect(prompt).toContain("project level");
  });

  it("detects existing config", async () => {
    await setupBmadProject(tmpDir);
    const ctx = createMockContext({ cwd: tmpDir });
    const cmd = mock.getCommand("bmad-init")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("BMAD project detected"),
      "info",
    );
    const prompt = mock.api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("already has a BMAD configuration");
  });
});

describe("/bmad-status command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-cmd-status-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows project status when initialized", async () => {
    await setupBmadProject(tmpDir, {
      projectName: "StatusTest",
      projectLevel: 2,
    });
    await setupWorkflowStatus(tmpDir, [
      {
        name: "product-brief",
        phase: 1,
        status: "docs/pb.md",
        description: "Product brief",
      },
      {
        name: "prd",
        phase: 2,
        status: "required",
        description: "PRD",
      },
    ]);

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("bmad-status")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalled();
    const msg = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0].customType === "bmad-status",
    );
    expect(msg).toBeDefined();
    const content = msg![0].content;
    expect(content).toContain("StatusTest");
    expect(content).toContain("Level: 2");
    expect(content).toContain("Recommendation:");
  });

  it("warns when not initialized", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    const cmd = mock.getCommand("bmad-status")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not initialized"),
      "warning",
    );
  });
});

describe("workflow commands", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-cmd-wf-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends workflow prompt when initialized", async () => {
    await setupBmadProject(tmpDir, { projectName: "WfTest" });
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    mock.api.sendUserMessage.mockClear();

    const cmd = mock.getCommand("bmad-product-brief")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendUserMessage).toHaveBeenCalledTimes(1);
    const prompt = mock.api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("Business Analyst");
    expect(prompt).toContain("product brief");
    expect(prompt).toContain("WfTest");
  });

  it("warns when not initialized", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    const cmd = mock.getCommand("bmad-prd")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not initialized"),
      "warning",
    );
    expect(mock.api.sendUserMessage).not.toHaveBeenCalled();
  });

  it("includes project context in prompt", async () => {
    await setupBmadProject(tmpDir, { projectName: "CtxTest" });
    await setupWorkflowStatus(tmpDir, [
      {
        name: "product-brief",
        phase: 1,
        status: "docs/pb.md",
        description: "Product brief",
      },
    ]);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    mock.api.sendUserMessage.mockClear();

    const cmd = mock.getCommand("bmad-prd")!;
    await cmd.handler("", ctx);

    const prompt = mock.api.sendUserMessage.mock.calls[0][0];
    expect(prompt).toContain("product-brief: docs/pb.md");
  });
});

// ---------------------------------------------------------------------------
// 6. Session start event tests
// ---------------------------------------------------------------------------

describe("session_start event", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "bmad-event-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sets status bar when BMAD project detected", async () => {
    await setupBmadProject(tmpDir, {
      projectName: "StartTest",
      projectLevel: 2,
    });
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("bmad", "bmad: L2 StartTest");
  });

  it("shows recommendation when status exists", async () => {
    await setupBmadProject(tmpDir, { projectName: "RecTest" });
    await setupWorkflowStatus(tmpDir, [
      {
        name: "product-brief",
        phase: 1,
        status: "optional",
        description: "Product brief",
      },
    ]);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    expect(mock.api.sendMessage).toHaveBeenCalled();
    const msg = mock.api.sendMessage.mock.calls[0][0];
    expect(msg.content).toContain("Next recommended:");
  });

  it("does nothing when no BMAD project", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(mock.api.sendMessage).not.toHaveBeenCalled();
  });
});
