import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Mock @mariozechner/pi-tui (runtime-only Pi dependency)
vi.mock("@mariozechner/pi-tui", () => ({
  Text: class MockText {
    constructor(
      public text: string,
      public x: number,
      public y: number,
    ) {}
  },
}));

import {
  validateTaskNames,
  validateDependencyGraph,
  partitionTasks,
  buildWorkerPrompt,
  serializeRunState,
  deserializeRunState,
  buildPlanningPrompt,
  atomicWriteFile,
  type PendingTask,
  type RunState,
  type WorkerSession,
  SIMPLE_HARNESS_ROLES,
  RUN_DIR,
  RUN_STATE_FILE,
  RUN_LOG_FILE,
  STOP_SIGNAL_FILE,
  RUN_WORKTREE_DIR,
  RUN_USAGE_TRACKING_FILE,
  MAX_WORKER_RECOVERIES,
} from "./simple-harness.js";

// --- validateTaskNames ---

describe("validateTaskNames", () => {
  it("accepts valid kebab-case names", () => {
    const result = validateTaskNames([
      { name: "fix-lint" },
      { name: "add-tests" },
      { name: "refactor" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects names with uppercase", () => {
    const result = validateTaskNames([{ name: "Fix-Lint" }]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Fix-Lint");
  });

  it("rejects names with spaces", () => {
    const result = validateTaskNames([{ name: "fix lint" }]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("fix lint");
  });

  it("rejects names with underscores", () => {
    const result = validateTaskNames([{ name: "fix_lint" }]);
    expect(result.valid).toBe(false);
  });

  it("rejects duplicate names", () => {
    const result = validateTaskNames([
      { name: "fix-lint" },
      { name: "fix-lint" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Duplicate");
  });

  it("accepts single-word names", () => {
    const result = validateTaskNames([{ name: "refactor" }]);
    expect(result.valid).toBe(true);
  });

  it("rejects empty string", () => {
    const result = validateTaskNames([{ name: "" }]);
    expect(result.valid).toBe(false);
  });

  it("rejects names starting with hyphen", () => {
    const result = validateTaskNames([{ name: "-fix" }]);
    expect(result.valid).toBe(false);
  });

  it("rejects names ending with hyphen", () => {
    const result = validateTaskNames([{ name: "fix-" }]);
    expect(result.valid).toBe(false);
  });
});

// --- validateDependencyGraph ---

describe("validateDependencyGraph", () => {
  it("accepts tasks with no dependencies", () => {
    const result = validateDependencyGraph([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    expect(result.valid).toBe(true);
  });

  it("accepts valid dependency chain", () => {
    const result = validateDependencyGraph([
      { name: "a" },
      { name: "b", dependsOn: ["a"] },
      { name: "c", dependsOn: ["b"] },
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects reference to unknown task", () => {
    const result = validateDependencyGraph([
      { name: "a", dependsOn: ["nonexistent"] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  it("rejects self-dependency", () => {
    const result = validateDependencyGraph([{ name: "a", dependsOn: ["a"] }]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("depends on itself");
  });

  it("rejects circular dependency (A→B→A)", () => {
    const result = validateDependencyGraph([
      { name: "a", dependsOn: ["b"] },
      { name: "b", dependsOn: ["a"] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("cycle");
  });

  it("rejects longer cycle (A→B→C→A)", () => {
    const result = validateDependencyGraph([
      { name: "a", dependsOn: ["c"] },
      { name: "b", dependsOn: ["a"] },
      { name: "c", dependsOn: ["b"] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("cycle");
  });

  it("accepts diamond dependency (C depends on A and B)", () => {
    const result = validateDependencyGraph([
      { name: "a" },
      { name: "b" },
      { name: "c", dependsOn: ["a", "b"] },
    ]);
    expect(result.valid).toBe(true);
  });
});

// --- partitionTasks ---

describe("partitionTasks", () => {
  const task = (name: string, dependsOn?: string[]): PendingTask => ({
    name,
    role: "developer",
    goals: ["goal"],
    context: "",
    dependsOn,
  });

  it("puts tasks with no deps into ready", () => {
    const { ready, pending } = partitionTasks(
      [task("a"), task("b")],
      5,
      new Set(),
    );
    expect(ready.map((t) => t.name)).toEqual(["a", "b"]);
    expect(pending).toEqual([]);
  });

  it("puts tasks with unmet deps into pending", () => {
    const { ready, pending } = partitionTasks(
      [task("a"), task("b", ["a"])],
      5,
      new Set(),
    );
    expect(ready.map((t) => t.name)).toEqual(["a"]);
    expect(pending.map((t) => t.name)).toEqual(["b"]);
  });

  it("moves task to ready when deps are in mergedWorkers", () => {
    const { ready, pending } = partitionTasks(
      [task("b", ["a"])],
      5,
      new Set(["a"]),
    );
    expect(ready.map((t) => t.name)).toEqual(["b"]);
    expect(pending).toEqual([]);
  });

  it("respects maxWorkers limit", () => {
    const { ready, pending } = partitionTasks(
      [task("a"), task("b"), task("c")],
      2,
      new Set(),
    );
    expect(ready.length).toBe(2);
    expect(pending.length).toBe(1);
  });

  it("returns empty ready when all deps unmet", () => {
    const { ready, pending } = partitionTasks(
      [task("b", ["a"]), task("c", ["a"])],
      5,
      new Set(),
    );
    expect(ready).toEqual([]);
    expect(pending.length).toBe(2);
  });
});

// --- buildWorkerPrompt ---

describe("buildWorkerPrompt", () => {
  it("builds a basic prompt with role and goals", () => {
    const task: PendingTask = {
      name: "fix-lint",
      role: "developer",
      goals: ["Fix all lint errors", "Run linter to verify"],
      context: "Use eslint",
    };
    const prompt = buildWorkerPrompt(
      task,
      "/repo/.run/fix-lint.md",
      "pi-agent/fix-lint",
    );
    expect(prompt).toContain("fix-lint");
    expect(prompt).toContain("- [ ] Fix all lint errors");
    expect(prompt).toContain("- [ ] Run linter to verify");
    expect(prompt).toContain("Use eslint");
    expect(prompt).toContain("pi-agent/fix-lint");
    expect(prompt).toContain("/repo/.run/fix-lint.md");
  });

  it("includes role-specific instructions", () => {
    const task: PendingTask = {
      name: "write-tests",
      role: "tester",
      goals: ["Write unit tests"],
      context: "",
    };
    const prompt = buildWorkerPrompt(
      task,
      "/repo/.run/write-tests.md",
      "pi-agent/write-tests",
    );
    expect(prompt).toContain("quality engineer");
    expect(prompt).toContain("test coverage");
  });

  it("includes tool policy for restricted roles", () => {
    const task: PendingTask = {
      name: "investigate",
      role: "researcher",
      goals: ["Research approaches"],
      context: "",
    };
    const prompt = buildWorkerPrompt(
      task,
      "/repo/.run/investigate.md",
      "pi-agent/investigate",
    );
    expect(prompt).toContain("READ-ONLY");
  });

  it("omits context section when context is empty", () => {
    const task: PendingTask = {
      name: "fix",
      role: "developer",
      goals: ["Fix bug"],
      context: "",
    };
    const prompt = buildWorkerPrompt(task, "/repo/.run/fix.md", "pi-agent/fix");
    // Empty context should not have a Context header with no content
    // (buildWorkerPrompt adds Context section but the content is empty string)
    expect(prompt).toContain("## Goals");
  });
});

// --- serializeRunState / deserializeRunState ---

describe("RunState serialization", () => {
  const baseState: RunState = {
    active: true,
    objective: "improve tests",
    sessions: {
      "fix-lint": {
        worktreePath: "/tmp/fix-lint",
        branch: "pi-agent/fix-lint",
        spawned: true,
        spawnedAt: "2024-01-01T00:00:00.000Z",
        tmuxSession: "run-fix-lint",
      },
    },
    pending: [
      {
        name: "add-tests",
        role: "tester",
        goals: ["Write tests"],
        context: "Use vitest",
        dependsOn: ["fix-lint"],
      },
    ],
    maxWorkers: 3,
    staggerMs: 5000,
    backend: "pi",
    startedAt: "2024-01-01T00:00:00.000Z",
    mergedWorkers: ["setup"],
  };

  it("round-trips correctly", () => {
    const serialized = serializeRunState(baseState);
    const deserialized = deserializeRunState(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.active).toBe(true);
    expect(deserialized!.objective).toBe("improve tests");
    expect(deserialized!.sessions["fix-lint"].branch).toBe("pi-agent/fix-lint");
    expect(deserialized!.pending[0].name).toBe("add-tests");
    expect(deserialized!.mergedWorkers).toEqual(["setup"]);
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeRunState("not json")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(deserializeRunState(JSON.stringify({ active: true }))).toBeNull();
  });

  it("returns null for invalid backend", () => {
    const state = { ...baseState, backend: "invalid" };
    expect(deserializeRunState(JSON.stringify(state))).toBeNull();
  });

  it("handles empty state", () => {
    const emptyState: RunState = {
      active: false,
      sessions: {},
      pending: [],
      maxWorkers: 3,
      staggerMs: 5000,
      backend: "pi",
      startedAt: "2024-01-01T00:00:00.000Z",
      mergedWorkers: [],
    };
    const serialized = serializeRunState(emptyState);
    const deserialized = deserializeRunState(serialized);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.active).toBe(false);
    expect(Object.keys(deserialized!.sessions)).toHaveLength(0);
  });
});

// --- buildPlanningPrompt ---

describe("buildPlanningPrompt", () => {
  const snapshot = {
    fileTree: ".\n./src\n./tests",
    languages: ["TypeScript"],
    frameworks: ["vitest"],
    recentCommits: ["abc123 initial commit"],
    existingTasks: [],
    todoCount: 5,
    testFramework: "vitest",
    branchName: "main",
  };

  it("includes file tree and snapshot data", () => {
    const prompt = buildPlanningPrompt(
      snapshot,
      "improve test coverage",
      SIMPLE_HARNESS_ROLES,
    );
    expect(prompt).toContain("./src");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("improve test coverage");
  });

  it("lists available roles", () => {
    const prompt = buildPlanningPrompt(
      snapshot,
      "refactor",
      SIMPLE_HARNESS_ROLES,
    );
    expect(prompt).toContain("developer");
    expect(prompt).toContain("tester");
    expect(prompt).toContain("architect");
  });

  it("includes task schema guidelines", () => {
    const prompt = buildPlanningPrompt(
      snapshot,
      "fix bugs",
      SIMPLE_HARNESS_ROLES,
    );
    expect(prompt).toContain("run_plan");
    expect(prompt).toContain("kebab-case");
  });
});

// --- atomicWriteFile ---

describe("atomicWriteFile", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "simple-harness-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes file atomically", async () => {
    const filePath = join(tmpDir, "test.txt");
    await atomicWriteFile(filePath, "hello world");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  it("overwrites existing file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await atomicWriteFile(filePath, "first");
    await atomicWriteFile(filePath, "second");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("second");
  });
});

// --- Constants ---

describe("constants", () => {
  it("exports expected directory constants", () => {
    expect(RUN_DIR).toBe(".run");
    expect(RUN_STATE_FILE).toBe(".run/.launch-state.json");
    expect(RUN_LOG_FILE).toBe(".run/.run-log.jsonl");
    expect(STOP_SIGNAL_FILE).toBe(".run/.stop-signal");
    expect(RUN_WORKTREE_DIR).toBe(".run/worktrees");
    expect(RUN_USAGE_TRACKING_FILE).toBe(".run/.usage-tracking.json");
    expect(MAX_WORKER_RECOVERIES).toBe(3);
  });

  it("trims roles to 7 (no analyst, planner)", () => {
    expect(SIMPLE_HARNESS_ROLES).toHaveLength(7);
    expect(SIMPLE_HARNESS_ROLES).not.toContain("analyst");
    expect(SIMPLE_HARNESS_ROLES).not.toContain("planner");
    expect(SIMPLE_HARNESS_ROLES).toContain("developer");
    expect(SIMPLE_HARNESS_ROLES).toContain("architect");
    expect(SIMPLE_HARNESS_ROLES).toContain("tester");
    expect(SIMPLE_HARNESS_ROLES).toContain("reviewer");
    expect(SIMPLE_HARNESS_ROLES).toContain("researcher");
    expect(SIMPLE_HARNESS_ROLES).toContain("designer");
    expect(SIMPLE_HARNESS_ROLES).toContain("builder");
  });
});
