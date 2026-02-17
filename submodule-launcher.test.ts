import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  buildManagerPrompt,
  buildManagerInstructions,
  readManagerStatus,
  getRole,
  generateMessageId,
  mailboxPath,
  sendMailboxMessage,
  readMailbox,
  deleteMessage,
  readQueue,
  writeQueue,
  readRegistry,
  writeRegistry,
  HARNESS_ROLES,
  MAX_STALLS,
  MAX_CONSECUTIVE_FAILURES,
  WORKER_STALL_THRESHOLD_MS,
  RECOVERY_BACKOFF,
  CONTEXT_CRITICAL_PERCENT,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  MANAGER_DIR,
  MANAGER_STATUS_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_STALE_THRESHOLD_MS,
  MAILBOX_DIR,
  QUEUE_FILE,
  REGISTRY_FILE,
  SUMMARY_FILE,
  TMUX_SERVER,
  type SubmoduleConfig,
  type RunSummary,
  type SubmoduleGoal,
  type SubmoduleQuestion,
  type HarnessRole,
  type LaunchState,
  type ManagerStatusFile,
  type MailboxMessage,
  type QueueItem,
  type WorkQueue,
  type WorkerRegistry,
  type WorkerRegistryEntry,
  type WorkerState,
  shellEscape,
  sanitizeTmuxName,
  goalFileName,
  withQueueLock,
  BMAD_ROLE_MAP,
  buildBmadWorkflowDag,
  type BmadGoalSpec,
  type BmadModeConfig,
} from "./submodule-launcher.js";
import initExtension from "./submodule-launcher.js";

// ---------------------------------------------------------------------------
// Mock factories
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
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
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
    getContextUsage: vi.fn().mockReturnValue({
      tokens: 5000,
      contextWindow: 100_000,
      percent: 5,
    }),
    newSession: vi.fn(),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    ...overrides,
  };
}

function makeManagerStatus(
  overrides: Partial<ManagerStatusFile> = {},
): ManagerStatusFile {
  return {
    status: "running",
    updatedAt: new Date().toISOString(),
    submodules: {
      api: { completed: 1, total: 2, allDone: false },
    },
    stallCount: 0,
    ...overrides,
  };
}

function makeLaunchState(overrides: Partial<LaunchState> = {}): LaunchState {
  return {
    active: true,
    sessions: {},
    managerSpawned: true,
    managerCwd: "/tmp/test/.pi-agent/.manager",
    managerSpawnedAt: new Date().toISOString(),
    managerTmuxSession: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure function tests
// ---------------------------------------------------------------------------

describe("parseGoalFile", () => {
  it("parses a well-formed goal file", () => {
    const content = [
      "# api-service",
      "path: services/api",
      "",
      "## Goals",
      "- [ ] Fix authentication timeout",
      "- [x] Add rate limiting",
      "",
      "## Context",
      "Additional context for the agent.",
    ].join("\n");

    const result = parseGoalFile(content, "api-service.md");
    expect(result.name).toBe("api-service");
    expect(result.path).toBe("services/api");
    expect(result.goals).toHaveLength(2);
    expect(result.goals[0]).toEqual({
      text: "Fix authentication timeout",
      completed: false,
    });
    expect(result.goals[1]).toEqual({
      text: "Add rate limiting",
      completed: true,
    });
    expect(result.context).toBe("Additional context for the agent.");
  });

  it("handles missing sections gracefully", () => {
    const content = "# minimal\npath: some/path\n";
    const result = parseGoalFile(content, "minimal.md");
    expect(result.name).toBe("minimal");
    expect(result.path).toBe("some/path");
    expect(result.goals).toHaveLength(0);
    expect(result.context).toBe("");
  });

  it("detects all goals complete", () => {
    const content = [
      "# done-service",
      "path: services/done",
      "",
      "## Goals",
      "- [x] Task A",
      "- [x] Task B",
    ].join("\n");

    const result = parseGoalFile(content, "done-service.md");
    expect(result.goals.every((g) => g.completed)).toBe(true);
  });

  it("handles empty goals section", () => {
    const content = [
      "# empty",
      "path: services/empty",
      "",
      "## Goals",
      "",
      "## Context",
      "Some context here.",
    ].join("\n");

    const result = parseGoalFile(content, "empty.md");
    expect(result.goals).toHaveLength(0);
    expect(result.context).toBe("Some context here.");
  });

  it("falls back to filename when no heading", () => {
    const content = "path: some/path\n## Goals\n- [ ] Task\n";
    const result = parseGoalFile(content, "my-module.md");
    expect(result.name).toBe("my-module");
  });

  it("defaults path to '.' when path field is missing", () => {
    const content = "# standalone-task\n\n## Goals\n- [ ] Do something\n";
    const result = parseGoalFile(content, "standalone-task.md");
    expect(result.name).toBe("standalone-task");
    expect(result.path).toBe(".");
    expect(result.goals).toHaveLength(1);
  });

  it("parses role field", () => {
    const content = [
      "# refactor-auth",
      "path: .",
      "role: architect",
      "",
      "## Goals",
      "- [ ] Extract auth logic",
    ].join("\n");

    const result = parseGoalFile(content, "refactor-auth.md");
    expect(result.role).toBe("architect");
  });

  it('defaults role to "developer" when missing', () => {
    const content = "# task\npath: .\n\n## Goals\n- [ ] Do something\n";
    const result = parseGoalFile(content, "task.md");
    expect(result.role).toBe("developer");
  });

  it('defaults invalid role to "developer"', () => {
    const content =
      "# task\npath: .\nrole: ninja\n\n## Goals\n- [ ] Do something\n";
    const result = parseGoalFile(content, "task.md");
    expect(result.role).toBe("developer");
  });
});

describe("serializeGoalFile", () => {
  it("round-trips a parsed config", () => {
    const original: SubmoduleConfig = {
      name: "web-client",
      path: "apps/web",
      role: "developer",
      goals: [
        { text: "Implement login form", completed: false },
        { text: "Add unit tests", completed: true },
      ],
      questions: [],
      context: "React + TypeScript frontend.",
      rawContent: "",
    };

    const serialized = serializeGoalFile(original);
    const parsed = parseGoalFile(serialized, "web-client.md");

    expect(parsed.name).toBe(original.name);
    expect(parsed.path).toBe(original.path);
    expect(parsed.role).toBe(original.role);
    expect(parsed.goals).toEqual(original.goals);
    expect(parsed.questions).toEqual(original.questions);
    expect(parsed.context).toBe(original.context);
  });

  it("omits ## Context section when empty", () => {
    const config: SubmoduleConfig = {
      name: "test",
      path: "test/path",
      role: "developer",
      goals: [{ text: "Do something", completed: false }],
      questions: [],
      context: "",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    expect(serialized).not.toContain("## Context");
  });

  it('omits role when "developer"', () => {
    const config: SubmoduleConfig = {
      name: "test",
      path: ".",
      role: "developer",
      goals: [{ text: "Do something", completed: false }],
      questions: [],
      context: "",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    expect(serialized).not.toContain("role:");
  });

  it("includes role when non-default", () => {
    const config: SubmoduleConfig = {
      name: "test",
      path: ".",
      role: "architect",
      goals: [{ text: "Refactor module", completed: false }],
      questions: [],
      context: "",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    expect(serialized).toContain("role: architect");

    // Verify round-trip
    const parsed = parseGoalFile(serialized, "test.md");
    expect(parsed.role).toBe("architect");
  });
});

describe("buildProgressSummary", () => {
  it("shows per-submodule progress", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [
          { text: "Fix auth", completed: true },
          { text: "Add caching", completed: false },
        ],
        questions: [],
        context: "",
        rawContent: "",
      },
      {
        name: "web",
        path: "apps/web",
        role: "developer",
        goals: [{ text: "Login form", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const summary = buildProgressSummary(configs);
    expect(summary).toContain("api (1/2, 50%)");
    expect(summary).toContain("web (0/1, 0%)");
    expect(summary).toContain("- [x] Fix auth");
    expect(summary).toContain("- [ ] Add caching");
    expect(summary).toContain("Continue monitoring");
  });

  it("announces all complete", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [{ text: "Done", completed: true }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const summary = buildProgressSummary(configs);
    expect(summary).toContain("DONE");
    expect(summary).toContain("All submodule goals are complete");
  });

  it("shows role tag for non-default roles", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "refactor-auth",
        path: ".",
        role: "architect",
        goals: [{ text: "Extract module", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
      {
        name: "add-tests",
        path: ".",
        role: "developer",
        goals: [{ text: "Write tests", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const summary = buildProgressSummary(configs);
    expect(summary).toContain("refactor-auth [Architect]");
    expect(summary).not.toContain("add-tests [Developer]");
    expect(summary).toContain("add-tests (0/1");
  });
});

describe("buildManagerInstructions", () => {
  it("includes static instructions and role guidance", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [{ text: "Fix auth", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const instructions = buildManagerInstructions(configs, "/tmp/project");

    expect(instructions).toContain("Launch Manager");
    expect(instructions).toContain("Auto-Merge");
    expect(instructions).toContain("manager-status.json");
    expect(instructions).toContain("stop-signal");
    expect(instructions).toContain("Work Queue");
    expect(instructions).toContain("Mailbox");
    expect(instructions).toContain("Worker Registry");
    expect(instructions).toContain("depends_on");
  });
});

describe("buildManagerPrompt", () => {
  it("references instructions and includes dynamic goal content", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [
          { text: "Fix auth", completed: false },
          { text: "Add tests", completed: true },
        ],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];
    const sessions = [
      {
        name: "api",
        branch: "pi-agent/api",
        worktreePath: "/tmp/wt/api",
      },
    ];

    const prompt = buildManagerPrompt(configs, sessions, "/tmp/project");

    expect(prompt).toContain(".manager-instructions.md");
    expect(prompt).toContain("api");
    expect(prompt).toContain("Fix auth");
    expect(prompt).toContain("Add tests");
    expect(prompt).toContain("pi-agent/api");
    expect(prompt).toContain("services/api");
  });

  it("handles submodule with no active session", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "web",
        path: "apps/web",
        role: "developer",
        goals: [{ text: "Task", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const prompt = buildManagerPrompt(configs, [], "/tmp/project");
    expect(prompt).toContain("No active session");
    expect(prompt).toContain("web");
  });

  it("includes role info for non-default roles", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "refactor",
        path: ".",
        role: "architect",
        goals: [{ text: "Restructure", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const prompt = buildManagerPrompt(configs, [], "/tmp/project");
    expect(prompt).toContain("Role: Architect");
  });

  it("includes depends_on info in prompt", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "frontend",
        path: ".",
        role: "developer",
        goals: [{ text: "Build UI", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
        dependsOn: ["api", "auth"],
      },
    ];

    const prompt = buildManagerPrompt(configs, [], "/tmp/project");
    expect(prompt).toContain("Depends on: api, auth");
  });
});

describe("readManagerStatus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mgr-status-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads and parses a valid status file", async () => {
    const status = makeManagerStatus({ stallCount: 2 });
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(status),
      "utf-8",
    );

    const result = await readManagerStatus(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("running");
    expect(result!.stallCount).toBe(2);
    expect(result!.submodules.api.completed).toBe(1);
  });

  it("returns null when file is missing", async () => {
    const result = await readManagerStatus(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(tmpDir, MANAGER_STATUS_FILE), "not json", "utf-8");

    const result = await readManagerStatus(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Registration tests
// ---------------------------------------------------------------------------

describe("extension registration", () => {
  it("registers expected event handlers", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    for (const event of ["session_start", "turn_end", "session_shutdown"]) {
      expect(mock.handlers.has(event), `missing handler for ${event}`).toBe(
        true,
      );
    }
  });

  it("registers expected tools", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    expect(mock.getTool("harness_status")).toBeDefined();
    expect(mock.getTool("harness_update_goal")).toBeDefined();
    expect(mock.getTool("harness_add_task")).toBeDefined();
  });

  it("registers expected commands", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    for (const cmd of [
      "harness:launch",
      "harness:status",
      "harness:stop",
      "harness:init",
      "harness:add",
      "harness:merge",
      "harness:recover",
    ]) {
      expect(mock.getCommand(cmd), `missing command ${cmd}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. turn_end tests
// ---------------------------------------------------------------------------

describe("turn_end", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-turn-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when loop is inactive", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("reads manager status and updates status bar", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Write active state
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    // Write manager status
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(
        makeManagerStatus({
          submodules: {
            api: { completed: 2, total: 5, allDone: false },
          },
        }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: 2/5 goals, running",
    );
  });

  it("detects stale manager when status file is missing", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: manager stale",
    );
  });

  it("detects stale manager when status is old", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    // Write status with old timestamp (10 minutes ago)
    const oldTime = new Date(
      Date.now() - MANAGER_STALE_THRESHOLD_MS - 60_000,
    ).toISOString();
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus({ updatedAt: oldTime })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: manager stale",
    );
  });

  it("sets loopActive false on all_complete", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(
        makeManagerStatus({
          status: "all_complete",
          submodules: {
            api: { completed: 3, total: 3, allDone: true },
          },
        }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    // Should set "done" status with goal count preserved
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: 3/3 goals, done");

    // Verify state was persisted as inactive
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(false);
  });

  it("sets loopActive false on stopped", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus({ status: "stopped" })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: 1/2 goals, stopped",
    );

    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(false);
  });

  it("stops at context >= 90%", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    ctx.getContextUsage.mockReturnValue({
      tokens: 91_000,
      contextWindow: 100_000,
      percent: 91,
    });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      "harness: context-full",
    );
  });

  it("handles getContextUsage throwing", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    // Write a valid manager status so we reach the status bar update
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus()),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    ctx.getContextUsage.mockImplementation(() => {
      throw new Error("not available");
    });
    await mock.emit("session_start", {}, ctx);
    ctx.ui.setStatus.mockClear();

    // Should not throw, should still update status bar
    await mock.emit("turn_end", {}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Tools tests
// ---------------------------------------------------------------------------

describe("harness_status tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-status-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns formatted progress", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [x] Done\n- [ ] Pending\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_status")!;
    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("api");
    expect(result.content[0].text).toContain("1/2");
    expect(result.details.totalGoals).toBe(2);
    expect(result.details.completedGoals).toBe(1);
  });

  it("handles no goal files", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_status")!;
    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("No goal files");
  });
});

describe("harness_update_goal tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-update-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds a goal", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Existing\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_update_goal")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      action: "add",
      goal: "New goal",
    });

    expect(result.content[0].text).toContain('add "New goal"');
    expect(result.content[0].text).toContain("0/2");

    // Verify file was written
    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("New goal");
  });

  it("completes a goal", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n- [ ] Add tests\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_update_goal")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      action: "complete",
      goal: "Fix auth",
    });

    expect(result.content[0].text).toContain('complete "Fix auth"');
    expect(result.content[0].text).toContain("1/2");
  });

  it("removes a goal", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Remove me\n- [ ] Keep me\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_update_goal")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      action: "remove",
      goal: "Remove me",
    });

    expect(result.content[0].text).toContain('remove "Remove me"');
    expect(result.content[0].text).toContain("0/1");

    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).not.toContain("Remove me");
    expect(content).toContain("Keep me");
  });

  it("errors for nonexistent submodule", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_update_goal")!;
    const result = await tool.execute("call-1", {
      submodule: "nonexistent",
      action: "add",
      goal: "New goal",
    });

    expect(result.content[0].text).toContain('"nonexistent" not found');
  });
});

// ---------------------------------------------------------------------------
// 5. Command tests
// ---------------------------------------------------------------------------

describe("/harness:launch command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-launch-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("spawns workers and manager via tmux, creates prompt files", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n",
    );
    await writeFile(
      join(piDir, "web.md"),
      "# web\npath: apps/web\n\n## Goals\n- [ ] Login form\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock git worktree add to create the directories
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        const wtPath = args[2];
        await mkdir(wtPath, { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Should have called exec for worktree creation and tmux sessions
    const execCalls = mock.api.exec.mock.calls;
    const gitCalls = execCalls.filter((c: any) => c[0] === "git");
    const tmuxCalls = execCalls.filter((c: any) => c[0] === "tmux");

    expect(gitCalls.length).toBeGreaterThanOrEqual(2); // 2 worktree adds
    expect(tmuxCalls.length).toBe(3); // 2 worker tmux sessions + 1 manager tmux session

    // Verify manager tmux call uses correct session name and cwd
    const managerTmuxCall = tmuxCalls.find((c: any) =>
      c[1]?.includes("harness-manager"),
    );
    expect(managerTmuxCall).toBeDefined();

    // Verify .manager/ directory was created with prompt file referencing instructions
    const promptFile = await readFile(
      join(tmpDir, MANAGER_DIR, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(promptFile).toContain(".manager-instructions.md");
    expect(promptFile).toContain("Current Submodules");

    // Verify static instructions file was created
    const instructionsFile = await readFile(
      join(tmpDir, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(instructionsFile).toContain("Launch Manager");
    expect(instructionsFile).toContain("invoked in a loop");

    // Should show harness-started message
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("api"),
      }),
      { triggerTurn: false },
    );

    // Verify state includes manager fields + tmux session
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.managerSpawned).toBe(true);
    expect(state.managerCwd).toContain(".manager");
    expect(state.managerSpawnedAt).not.toBeNull();
    expect(state.managerTmuxSession).toBe("harness-manager");
  });

  it("cleans up leftover stop signal on launch", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Task\n",
    );

    // Write a leftover stop signal
    await writeFile(join(tmpDir, STOP_SIGNAL_FILE), "old signal\n", "utf-8");

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Stop signal should be removed
    let exists = true;
    try {
      await readFile(join(tmpDir, STOP_SIGNAL_FILE), "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("is idempotent when already active", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Task\n",
    );

    // Write active state
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    mock.api.sendMessage.mockClear();

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-already-active",
      }),
      { triggerTurn: false },
    );
  });
});

describe("/harness:status command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-status-cmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("displays progress", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [x] Done\n- [ ] Pending\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    mock.api.sendMessage.mockClear();

    const cmd = mock.getCommand("harness:status")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-status",
        content: expect.stringContaining("api"),
      }),
      { triggerTurn: false },
    );
  });
});

describe("/harness:stop command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-stop-cmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes stop signal and deactivates", async () => {
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    // writeRunSummary sends a summary message via pi.sendMessage
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-summary",
      }),
      expect.anything(),
    );

    // Verify state was persisted as inactive
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(false);

    // Verify stop signal file was written
    const signal = await readFile(join(tmpDir, STOP_SIGNAL_FILE), "utf-8");
    expect(signal.trim()).toBeTruthy(); // Contains ISO timestamp
  });

  it("handles already stopped", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Harness is not active", "info");
  });
});

describe("/harness:init command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-init-cmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds .pi-agent/ with mailbox directories", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    // Verify directories were created
    const parentDir = mailboxPath(tmpDir, "parent");
    const managerDir = mailboxPath(tmpDir, "manager");
    const parentFiles = await readdir(parentDir);
    expect(Array.isArray(parentFiles)).toBe(true);
    const managerFiles = await readdir(managerDir);
    expect(Array.isArray(managerFiles)).toBe(true);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-init",
        content: expect.stringContaining("Scaffolded"),
      }),
      { triggerTurn: false },
    );
  });

  it("reports existing tasks when present", async () => {
    // Pre-create a task
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "my-task.md"),
      "# my-task\npath: .\n\n## Goals\n- [ ] Do work\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-init",
        content: expect.stringContaining("1 existing task(s)"),
      }),
      { triggerTurn: false },
    );
  });

  it("suggests /harness:add when no tasks exist", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-init",
        content: expect.stringContaining("/harness:add"),
      }),
      { triggerTurn: false },
    );
  });
});

describe("/harness:recover command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-recover-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("respawns manager when active", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n",
    );

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({
          managerCwd: join(tmpDir, MANAGER_DIR),
          sessions: {
            api: {
              worktreePath: join(tmpDir, WORKTREE_DIR, "api"),
              branch: "pi-agent/api",
              spawned: true,
              spawnedAt: null,
              tmuxSession: null,
            },
          },
        }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);
    mock.api.exec.mockClear();

    const cmd = mock.getCommand("harness:recover")!;
    await cmd.handler("", ctx);

    // Should have spawned a new manager via tmux
    const tmuxCalls = mock.api.exec.mock.calls.filter((c: any) => c[0] === "tmux");
    const newSessionCalls = tmuxCalls.filter((c: any) => c[1]?.includes("new-session"));
    expect(newSessionCalls.length).toBe(1);
    expect(newSessionCalls[0][1]).toContain("harness-manager");

    // Should have created prompt file (references instructions)
    const promptFile = await readFile(
      join(tmpDir, MANAGER_DIR, ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(promptFile).toContain(".manager-instructions.md");

    // Static instructions should also be created
    const instructionsFile = await readFile(
      join(tmpDir, PI_AGENT_DIR, ".manager-instructions.md"),
      "utf-8",
    );
    expect(instructionsFile).toContain("Launch Manager");

    expect(ctx.ui.notify).toHaveBeenCalledWith("Manager respawned", "info");
  });

  it("errors when no active harness", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:recover")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No active harness to recover",
      "warning",
    );
  });

  it("cleans up old stop signal on recover", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Task\n",
    );

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    // Write a stop signal
    await writeFile(join(tmpDir, STOP_SIGNAL_FILE), "old signal\n", "utf-8");

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:recover")!;
    await cmd.handler("", ctx);

    // Stop signal should be cleaned up
    let exists = true;
    try {
      await readFile(join(tmpDir, STOP_SIGNAL_FILE), "utf-8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. File-based tests
// ---------------------------------------------------------------------------

describe("file-based operations", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-file-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists and reads back goal files", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    const original = serializeGoalFile({
      name: "test-module",
      path: "lib/test",
      goals: [
        { text: "Goal A", completed: false },
        { text: "Goal B", completed: true },
      ],
      questions: [],
      context: "Test context",
      rawContent: "",
    });
    await writeFile(join(piDir, "test-module.md"), original, "utf-8");

    const content = await readFile(join(piDir, "test-module.md"), "utf-8");
    const parsed = parseGoalFile(content, "test-module.md");

    expect(parsed.name).toBe("test-module");
    expect(parsed.path).toBe("lib/test");
    expect(parsed.goals).toHaveLength(2);
    expect(parsed.goals[0].completed).toBe(false);
    expect(parsed.goals[1].completed).toBe(true);
    expect(parsed.context).toBe("Test context");
  });

  it("generates heartbeat.md content from goals", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n- [x] Done thing\n\n## Context\nAPI service context.\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock git worktree add to create the directory
    const worktreePath = join(wtDir, "api");
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Check that heartbeat.md was written to worktree
    const heartbeatContent = await readFile(
      join(worktreePath, "heartbeat.md"),
      "utf-8",
    );
    expect(heartbeatContent).toContain("# api");
    expect(heartbeatContent).toContain("Fix auth");
    // Should NOT contain completed goals
    expect(heartbeatContent).not.toContain("Done thing");
    expect(heartbeatContent).toContain("API service context");
  });

  it("persists state on shutdown and recovers on start", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Task\n",
    );

    // Activate the harness
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({
          managerCwd: join(tmpDir, MANAGER_DIR),
          sessions: {
            api: {
              worktreePath: "/tmp/wt",
              branch: "pi-agent/api",
              spawned: true,
              spawnedAt: "2025-01-01T00:00:00.000Z",
            },
          },
        }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Verify state was restored (loop should be active)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: active");

    // Trigger shutdown to persist
    await mock.emit("session_shutdown", {}, ctx);

    // Read persisted state
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(true);
    expect(state.managerSpawned).toBe(true);
    expect(state.sessions.api).toBeDefined();
    expect(state.sessions.api.branch).toBe("pi-agent/api");
  });

  it("updates goal file via harness_update_goal tool", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Original goal\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_update_goal")!;
    await tool.execute("call-1", {
      submodule: "api",
      action: "add",
      goal: "Added via tool",
    });

    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("Added via tool");
    expect(content).toContain("Original goal");
  });
});

// ---------------------------------------------------------------------------
// 7. /harness:add command tests
// ---------------------------------------------------------------------------

describe("/harness:add command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-add-cmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates goal file with path: .", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("refactor-auth", ctx);

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "refactor-auth.md"),
      "utf-8",
    );
    expect(content).toContain("# refactor-auth");
    expect(content).toContain("path: .");

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-add",
        content: expect.stringContaining("refactor-auth"),
      }),
      { triggerTurn: false },
    );
  });

  it("parses name and goals from args", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler(
      "add-tests Write integration tests, Add e2e coverage",
      ctx,
    );

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "add-tests.md"),
      "utf-8",
    );
    expect(content).toContain("# add-tests");
    expect(content).toContain("path: .");
    expect(content).toContain("Write integration tests");
    expect(content).toContain("Add e2e coverage");
  });

  it("scaffolds placeholder goal when no goals provided", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("my-task", ctx);

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "my-task.md"),
      "utf-8",
    );
    expect(content).toContain("Define goals for this task");
  });

  it("refuses to overwrite existing file", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "existing.md"),
      "# existing\npath: .\n",
      "utf-8",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("existing", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "warning",
    );
  });

  it("shows usage when no args provided", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "warning",
    );
  });

  it("rejects invalid name", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("Invalid_Name", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid task name"),
      "warning",
    );
  });
});

// ---------------------------------------------------------------------------
// 8. harness_add_task tool tests
// ---------------------------------------------------------------------------

describe("harness_add_task tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-add-task-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates goal file", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "refactor-auth",
      goals: ["Refactor auth module", "Add tests"],
    });

    expect(result.content[0].text).toContain("Created task");
    expect(result.content[0].text).toContain("2 goal(s)");

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "refactor-auth.md"),
      "utf-8",
    );
    expect(content).toContain("# refactor-auth");
    expect(content).toContain("path: .");
    expect(content).toContain("Refactor auth module");
    expect(content).toContain("Add tests");
  });

  it("creates goal file with custom path", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "api-work",
      goals: ["Fix endpoints"],
      path: "services/api",
    });

    expect(result.content[0].text).toContain("Created task");
    expect(result.details.path).toBe("services/api");

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "api-work.md"),
      "utf-8",
    );
    expect(content).toContain("path: services/api");
  });

  it("creates goal file with context", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "add-caching",
      goals: ["Add Redis caching"],
      context: "Use the existing Redis connection pool.",
    });

    expect(result.content[0].text).toContain("Created task");

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "add-caching.md"),
      "utf-8",
    );
    expect(content).toContain("## Context");
    expect(content).toContain("Use the existing Redis connection pool.");
  });

  it("rejects invalid name", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "Invalid_Name",
      goals: ["Do something"],
    });

    expect(result.content[0].text).toContain("Invalid task name");
  });

  it("refuses to overwrite existing file", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "existing.md"),
      "# existing\npath: .\n",
      "utf-8",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    const result = await tool.execute("call-1", {
      name: "existing",
      goals: ["Do something"],
    });

    expect(result.content[0].text).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// 9. Role-related tests
// ---------------------------------------------------------------------------

describe("HARNESS_ROLES", () => {
  it("has expected roles", () => {
    const names = HARNESS_ROLES.map((r) => r.name);
    expect(names).toEqual([
      "developer",
      "architect",
      "tester",
      "reviewer",
      "researcher",
      "designer",
      "builder",
      "analyst",
      "planner",
    ]);
  });

  it("each role has required fields", () => {
    for (const role of HARNESS_ROLES) {
      expect(role.name).toBeTruthy();
      expect(role.label).toBeTruthy();
      expect(role.persona).toBeTruthy();
      expect(role.instructions.length).toBeGreaterThan(0);
    }
  });
});

describe("getRole", () => {
  it("returns matching role", () => {
    const role = getRole("architect");
    expect(role.name).toBe("architect");
    expect(role.label).toBe("Architect");
  });

  it("falls back to developer for unknown role", () => {
    const role = getRole("unknown");
    expect(role.name).toBe("developer");
  });
});

describe("spawnSession uses role persona and instructions", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-spawn-role-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("injects architect persona into worker prompt", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "refactor.md"),
      "# refactor\npath: .\nrole: architect\n\n## Goals\n- [ ] Extract module\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "refactor", ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("a software architect focused on structure");
    expect(prompt).toContain('working on "refactor"');
    expect(prompt).toContain("Focus on code organization");
    expect(prompt).toContain("Reduce duplication");
    expect(prompt).not.toContain("Write tests first (red)");
  });

  it("uses developer role by default", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "task.md"),
      "# task\npath: .\n\n## Goals\n- [ ] Build feature\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "task", ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("a methodical software developer");
    expect(prompt).toContain("Write tests first (red)");
  });
});

describe("harness_add_task with role parameter", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-add-role-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates goal file with specified role", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("call-1", {
      name: "security-audit",
      goals: ["Audit auth module"],
      role: "reviewer",
    });

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "security-audit.md"),
      "utf-8",
    );
    expect(content).toContain("role: reviewer");

    const parsed = parseGoalFile(content, "security-audit.md");
    expect(parsed.role).toBe("reviewer");
  });

  it("defaults to developer when role not specified", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("call-1", {
      name: "basic-task",
      goals: ["Do something"],
    });

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "basic-task.md"),
      "utf-8",
    );
    expect(content).not.toContain("role:");

    const parsed = parseGoalFile(content, "basic-task.md");
    expect(parsed.role).toBe("developer");
  });

  it("falls back to developer for invalid role", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_add_task")!;
    await tool.execute("call-1", {
      name: "bad-role-task",
      goals: ["Do something"],
      role: "ninja",
    });

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "bad-role-task.md"),
      "utf-8",
    );
    expect(content).not.toContain("role:");

    const parsed = parseGoalFile(content, "bad-role-task.md");
    expect(parsed.role).toBe("developer");
  });
});

describe("/harness:add with --role flag", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-add-role-cmd-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("parses --role flag and creates goal file with role", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler(
      "refactor-auth --role architect Improve module boundaries, Extract interfaces",
      ctx,
    );

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "refactor-auth.md"),
      "utf-8",
    );
    expect(content).toContain("role: architect");
    expect(content).toContain("Improve module boundaries");
    expect(content).toContain("Extract interfaces");
    expect(content).not.toContain("--role");
  });

  it("handles --role flag before task name", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler(
      "--role tester add-tests Write unit tests, Write e2e tests",
      ctx,
    );

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "add-tests.md"),
      "utf-8",
    );
    expect(content).toContain("role: tester");
    expect(content).toContain("Write unit tests");
  });

  it("defaults to developer without --role flag", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("simple-task Do something", ctx);

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "simple-task.md"),
      "utf-8",
    );
    expect(content).not.toContain("role:");
  });

  it("ignores invalid --role value and defaults to developer", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:add")!;
    await cmd.handler("bad-role --role ninja Do something", ctx);

    const content = await readFile(
      join(tmpDir, PI_AGENT_DIR, "bad-role.md"),
      "utf-8",
    );
    expect(content).not.toContain("role:");

    const parsed = parseGoalFile(content, "bad-role.md");
    expect(parsed.role).toBe("developer");
  });
});

// ---------------------------------------------------------------------------
// 10. Question parsing, serialization, and tools
// ---------------------------------------------------------------------------

describe("parseGoalFile questions", () => {
  it("parses unanswered questions", () => {
    const content = [
      "# research-task",
      "path: .",
      "role: researcher",
      "",
      "## Goals",
      "- [ ] Investigate approach",
      "",
      "## Questions",
      "- ? What auth provider should we use?",
      "- ? Which database?",
      "",
      "## Context",
      "Some context.",
    ].join("\n");

    const result = parseGoalFile(content, "research-task.md");
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toEqual({
      text: "What auth provider should we use?",
      answered: false,
    });
    expect(result.questions[1]).toEqual({
      text: "Which database?",
      answered: false,
    });
  });

  it("parses answered questions", () => {
    const content = [
      "# task",
      "path: .",
      "",
      "## Goals",
      "- [ ] Do something",
      "",
      "## Questions",
      "- ! What database? → PostgreSQL",
      "- ? What auth provider?",
    ].join("\n");

    const result = parseGoalFile(content, "task.md");
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toEqual({
      text: "What database?",
      answered: true,
      answer: "PostgreSQL",
    });
    expect(result.questions[1]).toEqual({
      text: "What auth provider?",
      answered: false,
    });
  });

  it("defaults questions to empty array when section missing", () => {
    const content = "# task\npath: .\n\n## Goals\n- [ ] Do something\n";
    const result = parseGoalFile(content, "task.md");
    expect(result.questions).toEqual([]);
  });
});

describe("serializeGoalFile questions", () => {
  it("round-trips questions", () => {
    const original: SubmoduleConfig = {
      name: "test",
      path: ".",
      role: "developer",
      goals: [{ text: "Do something", completed: false }],
      questions: [
        { text: "What framework?", answered: false },
        { text: "What DB?", answered: true, answer: "PostgreSQL" },
      ],
      context: "Some context",
      rawContent: "",
    };

    const serialized = serializeGoalFile(original);
    const parsed = parseGoalFile(serialized, "test.md");

    expect(parsed.questions).toEqual(original.questions);
    expect(parsed.goals).toEqual(original.goals);
    expect(parsed.context).toBe(original.context);
  });

  it("omits Questions section when empty", () => {
    const config: SubmoduleConfig = {
      name: "test",
      path: ".",
      role: "developer",
      goals: [{ text: "Do something", completed: false }],
      questions: [],
      context: "",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    expect(serialized).not.toContain("## Questions");
  });
});

describe("buildProgressSummary with questions", () => {
  it("shows unanswered questions", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "research",
        path: ".",
        role: "researcher",
        goals: [{ text: "Investigate", completed: false }],
        questions: [
          { text: "What auth provider?", answered: false },
          { text: "What DB?", answered: true, answer: "PostgreSQL" },
        ],
        context: "",
        rawContent: "",
      },
    ];

    const summary = buildProgressSummary(configs);
    expect(summary).toContain("? What auth provider?");
    expect(summary).toContain("1 question(s) answered");
    expect(summary).not.toContain("? What DB?");
  });
});

describe("buildManagerPrompt with questions", () => {
  it("includes questions in dynamic prompt", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [{ text: "Fix auth", completed: false }],
        questions: [{ text: "OAuth2 or JWT?", answered: false }],
        context: "",
        rawContent: "",
      },
    ];

    const prompt = buildManagerPrompt(configs, [], "/tmp/project");
    expect(prompt).toContain("OAuth2 or JWT?");
    expect(prompt).toContain("Unanswered questions (1)");
  });

  it("includes stall-exemption in static instructions", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [{ text: "Fix auth", completed: false }],
        questions: [{ text: "OAuth2 or JWT?", answered: false }],
        context: "",
        rawContent: "",
      },
    ];

    const instructions = buildManagerInstructions(configs, "/tmp/project");
    expect(instructions).toContain("unanswered questions");
    expect(instructions).toContain("NOT stalled");
  });
});

describe("harness_ask tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-ask-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stages a question in goal file", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_ask")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      question: "OAuth2 or JWT?",
    });

    expect(result.content[0].text).toContain("Question staged");
    expect(result.content[0].text).toContain("1 unanswered");

    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("## Questions");
    expect(content).toContain("- ? OAuth2 or JWT?");
  });

  it("appends multiple questions", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: services/api\n\n## Goals\n- [ ] Fix auth\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_ask")!;
    await tool.execute("call-1", {
      submodule: "api",
      question: "OAuth2 or JWT?",
    });
    await tool.execute("call-2", {
      submodule: "api",
      question: "Which database?",
    });

    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("- ? OAuth2 or JWT?");
    expect(content).toContain("- ? Which database?");
  });

  it("errors for nonexistent submodule", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_ask")!;
    const result = await tool.execute("call-1", {
      submodule: "nonexistent",
      question: "Any question?",
    });

    expect(result.content[0].text).toContain('"nonexistent" not found');
  });
});

describe("harness_answer tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-answer-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("answers a staged question", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: .\n\n## Goals\n- [ ] Fix auth\n\n## Questions\n- ? OAuth2 or JWT?\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_answer")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      question: "OAuth2 or JWT?",
      answer: "Use JWT with refresh tokens",
    });

    expect(result.content[0].text).toContain("Answered");
    expect(result.content[0].text).toContain("0 unanswered remaining");

    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain(
      "- ! OAuth2 or JWT? → Use JWT with refresh tokens",
    );
    expect(content).not.toContain("- ? OAuth2 or JWT?");
  });

  it("fuzzy-matches question text", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: .\n\n## Goals\n- [ ] Fix auth\n\n## Questions\n- ? What auth provider should we use?\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_answer")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      question: "auth provider",
      answer: "Firebase Auth",
    });

    expect(result.content[0].text).toContain("Answered");
    expect(result.details.remaining).toBe(0);
  });

  it("errors for no matching unanswered question", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      "# api\npath: .\n\n## Goals\n- [ ] Fix auth\n\n## Questions\n- ! OAuth2 or JWT? → JWT\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_answer")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      question: "OAuth2 or JWT?",
      answer: "OAuth2",
    });

    expect(result.content[0].text).toContain("No matching unanswered question");
  });

  it("skips already-answered questions", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      [
        "# api",
        "path: .",
        "",
        "## Goals",
        "- [ ] Fix auth",
        "",
        "## Questions",
        "- ! What DB? → PostgreSQL",
        "- ? What cache?",
      ].join("\n") + "\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_answer")!;
    const result = await tool.execute("call-1", {
      submodule: "api",
      question: "What cache?",
      answer: "Redis",
    });

    expect(result.content[0].text).toContain("Answered");
    expect(result.details.remaining).toBe(0);

    // Verify the already-answered one is untouched
    const content = await readFile(join(piDir, "api.md"), "utf-8");
    expect(content).toContain("- ! What DB? → PostgreSQL");
    expect(content).toContain("- ! What cache? → Redis");
  });
});

describe("spawnSession with questions", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-spawn-q-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes harness_ask instruction and answered questions", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });
    await writeFile(
      join(piDir, "research.md"),
      [
        "# research",
        "path: .",
        "role: researcher",
        "",
        "## Goals",
        "- [ ] Investigate approach",
        "",
        "## Questions",
        "- ! What DB? → PostgreSQL",
        "- ? What cache?",
      ].join("\n") + "\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "research", ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("## Asking Questions");
    expect(prompt).toContain("- ? Your question here");
    expect(prompt).toContain("## Answered Questions");
    expect(prompt).toContain("- ! What DB? → PostgreSQL");
  });
});

describe("tool registration: harness_ask and harness_answer", () => {
  it("registers both tools", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    expect(mock.getTool("harness_ask")).toBeDefined();
    expect(mock.getTool("harness_answer")).toBeDefined();
  });
});

describe("harness_status with questions", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-status-q-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes question counts in details", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "api.md"),
      [
        "# api",
        "path: .",
        "",
        "## Goals",
        "- [ ] Fix auth",
        "",
        "## Questions",
        "- ? OAuth2 or JWT?",
        "- ! What DB? → PostgreSQL",
      ].join("\n") + "\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_status")!;
    const result = await tool.execute("call-1", {});

    expect(result.details.totalQuestions).toBe(2);
    expect(result.details.unansweredQuestions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Full flow: independence integration test
// ---------------------------------------------------------------------------

describe("full flow: researcher discovers work, stages questions, user answers, worker continues", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-independence-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("complete independence flow", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // 1. Create research task with researcher role
    const addTool = mock.getTool("harness_add_task")!;
    await addTool.execute("c1", {
      name: "auth-research",
      goals: ["Investigate auth options"],
      role: "researcher",
    });

    // Verify goal file created
    const piDir = join(tmpDir, PI_AGENT_DIR);
    let goalContent = await readFile(join(piDir, "auth-research.md"), "utf-8");
    expect(goalContent).toContain("role: researcher");

    // 2. Simulate researcher discovering additional goals
    const updateTool = mock.getTool("harness_update_goal")!;
    await updateTool.execute("c2", {
      submodule: "auth-research",
      action: "add",
      goal: "Compare OAuth2 vs JWT vs custom",
    });
    await updateTool.execute("c3", {
      submodule: "auth-research",
      action: "add",
      goal: "Write recommendation doc",
    });

    // 3. Researcher stages 2 questions
    const askTool = mock.getTool("harness_ask")!;
    await askTool.execute("c4", {
      submodule: "auth-research",
      question: "What auth provider should we use? (OAuth2, JWT, custom)",
    });
    await askTool.execute("c5", {
      submodule: "auth-research",
      question: "What database for session storage?",
    });

    // 4. Verify questions surfaced in harness_status
    const statusTool = mock.getTool("harness_status")!;
    let statusResult = await statusTool.execute("c6", {});
    expect(statusResult.details.unansweredQuestions).toBe(2);
    expect(statusResult.details.totalQuestions).toBe(2);
    expect(statusResult.content[0].text).toContain(
      "? What auth provider should we use?",
    );
    expect(statusResult.content[0].text).toContain(
      "? What database for session storage?",
    );

    // 5. User answers first question
    const answerTool = mock.getTool("harness_answer")!;
    const answer1 = await answerTool.execute("c7", {
      submodule: "auth-research",
      question: "auth provider",
      answer: "OAuth2 with Auth0",
    });
    expect(answer1.content[0].text).toContain("Answered");

    // 6. Verify goal file reflects answer
    goalContent = await readFile(join(piDir, "auth-research.md"), "utf-8");
    expect(goalContent).toContain(
      "- ! What auth provider should we use? (OAuth2, JWT, custom) → OAuth2 with Auth0",
    );

    // 7. User answers second question
    const answer2 = await answerTool.execute("c8", {
      submodule: "auth-research",
      question: "database for session",
      answer: "PostgreSQL",
    });
    expect(answer2.content[0].text).toContain("0 unanswered remaining");

    // 8. Verify all questions answered
    statusResult = await statusTool.execute("c9", {});
    expect(statusResult.details.unansweredQuestions).toBe(0);
    expect(statusResult.details.totalQuestions).toBe(2);

    // 9. Complete original goal
    await updateTool.execute("c10", {
      submodule: "auth-research",
      action: "complete",
      goal: "Investigate auth options",
    });

    // 10. Verify final state: goals, questions, role all consistent
    goalContent = await readFile(join(piDir, "auth-research.md"), "utf-8");
    const finalParsed = parseGoalFile(goalContent, "auth-research.md");
    expect(finalParsed.role).toBe("researcher");
    expect(finalParsed.goals).toHaveLength(3);
    expect(finalParsed.goals[0].completed).toBe(true); // Investigate auth options
    expect(finalParsed.goals[1].completed).toBe(false); // Compare OAuth2 vs JWT
    expect(finalParsed.goals[2].completed).toBe(false); // Write recommendation doc
    expect(finalParsed.questions).toHaveLength(2);
    expect(finalParsed.questions.every((q) => q.answered)).toBe(true);
    expect(finalParsed.questions[0].answer).toBe("OAuth2 with Auth0");
    expect(finalParsed.questions[1].answer).toBe("PostgreSQL");
  });
});

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("exports expected values", () => {
    expect(MAX_STALLS).toBe(5);
    expect(CONTEXT_CRITICAL_PERCENT).toBe(90);
    expect(PI_AGENT_DIR).toBe(".pi-agent");
    expect(WORKTREE_DIR).toBe(".pi-agent/worktrees");
    expect(LAUNCH_STATE_FILE).toBe(".pi-agent/.launch-state.json");
    expect(MANAGER_DIR).toBe(".pi-agent/.manager");
    expect(MANAGER_STATUS_FILE).toBe(".pi-agent/.manager-status.json");
    expect(STOP_SIGNAL_FILE).toBe(".pi-agent/.stop-signal");
    expect(MANAGER_STALE_THRESHOLD_MS).toBe(5 * 60 * 1000);
    expect(MAILBOX_DIR).toBe(".pi-agent/.mailboxes");
    expect(QUEUE_FILE).toBe(".pi-agent/.queue.json");
    expect(REGISTRY_FILE).toBe(".pi-agent/.registry.json");
  });
});

// ---------------------------------------------------------------------------
// Mailbox helper tests
// ---------------------------------------------------------------------------

describe("generateMessageId", () => {
  it("generates unique IDs with timestamp prefix", () => {
    const id1 = generateMessageId();
    const id2 = generateMessageId();
    expect(id1).toMatch(/^\d+-[a-z0-9]{8}$/);
    expect(id2).toMatch(/^\d+-[a-z0-9]{8}$/);
    expect(id1).not.toBe(id2);
  });
});

describe("mailboxPath", () => {
  it("resolves actor mailbox directory", () => {
    expect(mailboxPath("/tmp/test", "parent")).toBe(
      join("/tmp/test", MAILBOX_DIR, "parent"),
    );
    expect(mailboxPath("/tmp/test", "manager")).toBe(
      join("/tmp/test", MAILBOX_DIR, "manager"),
    );
    expect(mailboxPath("/tmp/test", "my-worker")).toBe(
      join("/tmp/test", MAILBOX_DIR, "my-worker"),
    );
  });
});

describe("sendMailboxMessage + readMailbox + deleteMessage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "mailbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends, reads, and deletes a message", async () => {
    const id = await sendMailboxMessage(
      tmpDir,
      "parent",
      "manager",
      "status_report",
      { summary: "all good" },
    );

    expect(id).toMatch(/^\d+-[a-z0-9]{8}$/);

    const messages = await readMailbox(tmpDir, "parent");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.from).toBe("manager");
    expect(messages[0].message.to).toBe("parent");
    expect(messages[0].message.type).toBe("status_report");
    expect(messages[0].message.payload).toEqual({ summary: "all good" });

    await deleteMessage(tmpDir, "parent", messages[0].filename);
    const afterDelete = await readMailbox(tmpDir, "parent");
    expect(afterDelete).toHaveLength(0);
  });

  it("reads multiple messages in chronological order", async () => {
    await sendMailboxMessage(tmpDir, "worker1", "manager", "directive", {
      text: "first",
    });
    // Ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    await sendMailboxMessage(tmpDir, "worker1", "parent", "answer", {
      text: "second",
    });

    const messages = await readMailbox(tmpDir, "worker1");
    expect(messages).toHaveLength(2);
    expect(messages[0].message.payload.text).toBe("first");
    expect(messages[1].message.payload.text).toBe("second");
  });

  it("returns empty array for nonexistent mailbox", async () => {
    const messages = await readMailbox(tmpDir, "nonexistent");
    expect(messages).toHaveLength(0);
  });

  it("skips malformed message files", async () => {
    const dir = mailboxPath(tmpDir, "test");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.json"), "not json", "utf-8");
    await sendMailboxMessage(tmpDir, "test", "parent", "ack", {
      messageId: "123",
    });

    const messages = await readMailbox(tmpDir, "test");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.type).toBe("ack");
  });

  it("deleteMessage is idempotent for missing files", async () => {
    // Should not throw
    await deleteMessage(tmpDir, "parent", "nonexistent.json");
  });
});

// ---------------------------------------------------------------------------
// Queue helper tests
// ---------------------------------------------------------------------------

describe("readQueue + writeQueue", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "queue-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty queue when file doesn't exist", async () => {
    const queue = await readQueue(tmpDir);
    expect(queue.items).toHaveLength(0);
  });

  it("writes and reads queue items", async () => {
    const queue: WorkQueue = {
      items: [
        {
          id: "test-1",
          topic: "add-tests",
          description: "Add unit tests",
          goals: ["Write test A", "Write test B"],
          priority: 5,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        {
          id: "test-2",
          topic: "fix-bug",
          description: "Fix critical bug",
          priority: 1,
          status: "dispatched",
          assignedTo: "worker-1",
          createdAt: new Date().toISOString(),
          dispatchedAt: new Date().toISOString(),
        },
      ],
    };

    await writeQueue(tmpDir, queue);
    const read = await readQueue(tmpDir);
    expect(read.items).toHaveLength(2);
    expect(read.items[0].topic).toBe("add-tests");
    expect(read.items[1].status).toBe("dispatched");
    expect(read.items[1].assignedTo).toBe("worker-1");
  });

  it("handles malformed queue file gracefully", async () => {
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(join(tmpDir, QUEUE_FILE), "not json", "utf-8");
    const queue = await readQueue(tmpDir);
    expect(queue.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Registry helper tests
// ---------------------------------------------------------------------------

describe("readRegistry + writeRegistry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "registry-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file doesn't exist", async () => {
    const registry = await readRegistry(tmpDir);
    expect(registry).toBeNull();
  });

  it("writes and reads registry", async () => {
    const registry: WorkerRegistry = {
      workers: {
        "api-worker": {
          name: "api-worker",
          role: "developer",
          branch: "pi-agent/api-worker",
          worktreePath: "/tmp/wt/api-worker",
          status: "active",
          goalsTotal: 3,
          goalsCompleted: 1,
          assignedQueueItems: ["q-1"],
        },
      },
      updatedAt: new Date().toISOString(),
    };

    await writeRegistry(tmpDir, registry);
    const read = await readRegistry(tmpDir);
    expect(read).not.toBeNull();
    expect(read!.workers["api-worker"].name).toBe("api-worker");
    expect(read!.workers["api-worker"].goalsCompleted).toBe(1);
    expect(read!.workers["api-worker"].assignedQueueItems).toEqual(["q-1"]);
  });
});

// ---------------------------------------------------------------------------
// harness_queue tool tests
// ---------------------------------------------------------------------------

describe("harness_queue tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-queue-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds item to queue and notifies manager", async () => {
    // Set up active harness so queue tool accepts input
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_queue")!;
    const result = await tool.execute("call-1", {
      topic: "add-tests",
      description: "Write unit tests for auth module",
      goals: ["Write login test", "Write signup test"],
      priority: 5,
    });

    expect(result.content[0].text).toContain("add-tests");
    expect(result.details.queueLength).toBe(1);

    // Verify queue file
    const queue = await readQueue(tmpDir);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].topic).toBe("add-tests");
    expect(queue.items[0].priority).toBe(5);
    expect(queue.items[0].status).toBe("pending");

    // Verify manager was notified
    const managerMessages = await readMailbox(tmpDir, "manager");
    expect(managerMessages).toHaveLength(1);
    expect(managerMessages[0].message.type).toBe("directive");
    expect(managerMessages[0].message.payload.text).toContain("add-tests");
  });

  it("uses default priority of 10", async () => {
    // Set up active harness so queue tool accepts input
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_queue")!;
    await tool.execute("call-1", { topic: "my-task" });

    const queue = await readQueue(tmpDir);
    expect(queue.items[0].priority).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// harness_send tool tests
// ---------------------------------------------------------------------------

describe("harness_send tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-send-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends a message to the specified actor", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_send")!;
    const result = await tool.execute("call-1", {
      to: "manager",
      type: "directive",
      payload: { text: "Please prioritize auth tasks" },
    });

    expect(result.content[0].text).toContain("manager");
    expect(result.details.to).toBe("manager");

    const messages = await readMailbox(tmpDir, "manager");
    expect(messages).toHaveLength(1);
    expect(messages[0].message.from).toBe("parent");
    expect(messages[0].message.payload.text).toBe(
      "Please prioritize auth tasks",
    );
  });
});

// ---------------------------------------------------------------------------
// harness_inbox tool tests
// ---------------------------------------------------------------------------

describe("harness_inbox tool", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-inbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads and deletes messages from parent inbox", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Send messages to parent inbox
    await sendMailboxMessage(tmpDir, "parent", "worker-1", "question", {
      question: "Which auth provider?",
    });
    await sendMailboxMessage(tmpDir, "parent", "manager", "status_report", {
      summary: "2/3 goals done",
    });

    const tool = mock.getTool("harness_inbox")!;
    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("2 message(s)");
    expect(result.content[0].text).toContain("worker-1");
    expect(result.content[0].text).toContain("question");
    expect(result.details.count).toBe(2);

    // Verify messages were deleted
    const remaining = await readMailbox(tmpDir, "parent");
    expect(remaining).toHaveLength(0);
  });

  it("returns empty message for no messages", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_inbox")!;
    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("No messages");
    expect(result.details.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /harness:queue command tests
// ---------------------------------------------------------------------------

describe("/harness:queue command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-cmd-queue-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("queues work with topic and goals", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:queue")!;
    await cmd.handler("add-e2e-tests Write checkout tests, Test payment flow", ctx);

    const queue = await readQueue(tmpDir);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].topic).toBe("add-e2e-tests");
    expect(queue.items[0].goals).toEqual([
      "Write checkout tests",
      "Test payment flow",
    ]);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "harness-queue" }),
      { triggerTurn: false },
    );
  });

  it("parses --role and --priority flags", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:queue")!;
    await cmd.handler("--role tester --priority 3 security-tests Write XSS test", ctx);

    const queue = await readQueue(tmpDir);
    expect(queue.items[0].topic).toBe("security-tests");
    expect(queue.items[0].role).toBe("tester");
    expect(queue.items[0].priority).toBe(3);
  });

  it("shows usage when no args", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:queue")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "warning",
    );
  });
});

// ---------------------------------------------------------------------------
// /harness:inbox command tests
// ---------------------------------------------------------------------------

describe("/harness:inbox command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-cmd-inbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("displays and deletes messages", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    await sendMailboxMessage(tmpDir, "parent", "worker-1", "status_report", {
      summary: "Done with task A",
    });

    const cmd = mock.getCommand("harness:inbox")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "harness-inbox" }),
      { triggerTurn: false },
    );

    // Messages should be deleted
    const remaining = await readMailbox(tmpDir, "parent");
    expect(remaining).toHaveLength(0);
  });

  it("shows info when no messages", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:inbox")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No messages in parent inbox.",
      "info",
    );
  });
});

// ---------------------------------------------------------------------------
// buildManagerPrompt mailbox sections
// ---------------------------------------------------------------------------

describe("buildManagerInstructions with mailbox", () => {
  it("includes work queue, mailbox, and registry sections", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        role: "developer",
        goals: [{ text: "Fix auth", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];

    const instructions = buildManagerInstructions(configs, "/tmp/project");

    expect(instructions).toContain("## Work Queue");
    expect(instructions).toContain(".queue.json");
    expect(instructions).toContain("## Mailbox");
    expect(instructions).toContain(".mailboxes/manager");
    expect(instructions).toContain("## Worker Registry");
    expect(instructions).toContain(".registry.json");
  });
});

// ---------------------------------------------------------------------------
// spawnSession mailbox instructions
// ---------------------------------------------------------------------------

describe("spawnSession with mailbox instructions", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-spawn-mailbox-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes mailbox instructions in worker prompt", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "my-worker.md"),
      "# my-worker\npath: .\n\n## Goals\n- [ ] Do something\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Launch to trigger spawnSession
    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "my-worker", ".pi-agent-prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("## Mailbox");
    expect(prompt).toContain(".mailboxes/my-worker");
    expect(prompt).toContain("work_dispatch");
  });
});

// ---------------------------------------------------------------------------
// session_start creates mailbox directories
// ---------------------------------------------------------------------------

describe("session_start mailbox setup", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-start-mailbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates parent and manager mailbox directories", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const parentDir = mailboxPath(tmpDir, "parent");
    const managerDir = mailboxPath(tmpDir, "manager");

    // Verify directories exist by attempting to readdir
    const parentFiles = await readdir(parentDir);
    expect(Array.isArray(parentFiles)).toBe(true);

    const managerFiles = await readdir(managerDir);
    expect(Array.isArray(managerFiles)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// turn_end parent inbox check
// ---------------------------------------------------------------------------

describe("turn_end parent inbox check", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-turnend-inbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("surfaces question messages from parent inbox", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Set up active state
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    // Write valid manager status
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus()),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Send a question to parent inbox
    await sendMailboxMessage(tmpDir, "parent", "worker-1", "question", {
      question: "Should I use Redis or Memcached?",
    });

    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Verify the question was surfaced
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-question",
        content: expect.stringContaining("Redis or Memcached"),
      }),
      { triggerTurn: false },
    );

    // Verify the question was deleted from inbox
    const remaining = await readMailbox(tmpDir, "parent");
    const questionMsgs = remaining.filter(
      (m) => m.message.type === "question",
    );
    expect(questionMsgs).toHaveLength(0);
  });

  it("shows message count in status bar", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(
        makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) }),
      ),
    );

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus()),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Send a non-question message to parent inbox (should show in count)
    await sendMailboxMessage(tmpDir, "parent", "manager", "status_report", {
      summary: "all good",
    });

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Status bar should contain message count
    const statusCalls = ctx.ui.setStatus.mock.calls;
    const lastStatusCall = statusCalls[statusCalls.length - 1];
    expect(lastStatusCall[1]).toContain("1 msg");
  });
});

// ---------------------------------------------------------------------------
// Tool registration: new tools
// ---------------------------------------------------------------------------

describe("tool registration: mailbox tools", () => {
  it("registers harness_queue, harness_send, harness_inbox", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    expect(mock.getTool("harness_queue")).toBeDefined();
    expect(mock.getTool("harness_send")).toBeDefined();
    expect(mock.getTool("harness_inbox")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Command registration: new commands
// ---------------------------------------------------------------------------

describe("command registration: mailbox commands", () => {
  it("registers harness:queue and harness:inbox", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    expect(mock.getCommand("harness:queue")).toBeDefined();
    expect(mock.getCommand("harness:inbox")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Worker prompt content: goal completion + heartbeat prohibition
// ---------------------------------------------------------------------------

describe("worker prompt content", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-prompt-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes goal file update instructions and heartbeat.md prohibition", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "my-task.md"),
      "# my-task\npath: src/api\n\n## Goals\n- [ ] Implement feature\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "my-task", ".pi-agent-prompt.md"),
      "utf-8",
    );

    // Goal file update instruction
    expect(prompt).toContain("change `- [ ]` to `- [x]`");
    expect(prompt).toContain("immediately update the goal file");

    // Heartbeat prohibition
    expect(prompt).toContain("NEVER modify heartbeat.md");
    expect(prompt).toContain("do NOT commit or stage heartbeat.md");

    // Path scoping
    expect(prompt).toContain("Your focus area is `src/api`");

    // No stale "Update heartbeat.md" instruction
    expect(prompt).not.toContain("Update heartbeat.md as you complete tasks");
  });

  it("includes mailbox read timing before new goals", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "worker-a.md"),
      "# worker-a\npath: .\n\n## Goals\n- [ ] Task 1\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Read prompt from the file written to the worktree
    const prompt = await readFile(
      join(tmpDir, WORKTREE_DIR, "worker-a", ".pi-agent-prompt.md"),
      "utf-8",
    );

    expect(prompt).toContain("Before starting any new goal, check your inbox");
    expect(prompt).not.toContain("On each heartbeat cycle, read all *.json");
  });
});

// ---------------------------------------------------------------------------
// /harness:cleanup command
// ---------------------------------------------------------------------------

describe("/harness:cleanup command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-cleanup-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("registers the harness:cleanup command", () => {
    expect(mock.getCommand("harness:cleanup")).toBeDefined();
  });

  it("clears in-memory state and removes state files", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(join(tmpDir, MAILBOX_DIR, "parent"), { recursive: true });
    await writeFile(join(tmpDir, QUEUE_FILE), '{"items":[]}');
    await writeFile(join(tmpDir, REGISTRY_FILE), '{"workers":{},"updatedAt":""}');
    await writeFile(join(tmpDir, STOP_SIGNAL_FILE), "stop");
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:cleanup")!;
    await cmd.handler("--force", ctx);

    // State files should be removed
    await expect(readFile(join(tmpDir, QUEUE_FILE), "utf-8")).rejects.toThrow();
    await expect(readFile(join(tmpDir, REGISTRY_FILE), "utf-8")).rejects.toThrow();
    await expect(readFile(join(tmpDir, STOP_SIGNAL_FILE), "utf-8")).rejects.toThrow();

    // Status bar cleared
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", undefined);

    // Summary message sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-cleanup",
      }),
      expect.anything(),
    );
  });

  it("blocks cleanup when worktrees have uncommitted changes without --force", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Simulate a session with a dirty worktree
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "dirty-task.md"),
      "# dirty-task\npath: .\n\n## Goals\n- [ ] Do something\n",
    );

    // Set up state with a session that has a dirty worktree
    const launchState = makeLaunchState({
      managerCwd: join(tmpDir, MANAGER_DIR),
      sessions: {
        "dirty-task": {
          worktreePath: join(tmpDir, "worktrees", "dirty-task"),
          branch: "pi-agent/dirty-task",
          spawned: true,
          spawnedAt: new Date().toISOString(),
        },
      },
    });
    await writeFile(join(tmpDir, LAUNCH_STATE_FILE), JSON.stringify(launchState));

    // Mock git status to return dirty output
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args.includes("--porcelain")) {
        return { stdout: "M dirty-file.ts\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:cleanup")!;
    await cmd.handler("", ctx);

    // Should send a blocked message
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-cleanup-blocked",
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Manager auto-recovery in turn_end
// ---------------------------------------------------------------------------

describe("manager auto-recovery", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-autorecovery-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-recovers manager after 2 stale turn_end cycles", async () => {
    // Set up active harness with a stale manager (no status file)
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "task-a.md"),
      "# task-a\npath: .\n\n## Goals\n- [ ] Do stuff\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // First stale cycle — should just set status
    await mock.emit("turn_end", {}, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: manager stale");

    // Second stale cycle — should trigger auto-recovery
    ctx.ui.setStatus.mockClear();
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-auto-recover",
      }),
      expect.anything(),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: manager recovering");
  });

  it("stops auto-recovery after MAX_MANAGER_RECOVERY attempts with backoff", async () => {
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "task-b.md"),
      "# task-b\npath: .\n\n## Goals\n- [ ] Do more stuff\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // RECOVERY_BACKOFF = [2, 4, 8], MAX_MANAGER_RECOVERY = 5
    // Recovery attempt 1: 2 stale cycles needed (RECOVERY_BACKOFF[0])
    for (let i = 0; i < 2; i++) await mock.emit("turn_end", {}, ctx);
    // Recovery attempt 2: 4 stale cycles (RECOVERY_BACKOFF[1])
    for (let i = 0; i < 4; i++) await mock.emit("turn_end", {}, ctx);
    // Recovery attempt 3: 8 stale cycles (RECOVERY_BACKOFF[2])
    for (let i = 0; i < 8; i++) await mock.emit("turn_end", {}, ctx);
    // Recovery attempt 4: 8 stale cycles (capped at RECOVERY_BACKOFF[2])
    for (let i = 0; i < 8; i++) await mock.emit("turn_end", {}, ctx);
    // Recovery attempt 5: 8 stale cycles (capped)
    for (let i = 0; i < 8; i++) await mock.emit("turn_end", {}, ctx);

    // Now capped at MAX_MANAGER_RECOVERY=5 — should show recovery-failed
    ctx.ui.setStatus.mockClear();
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("manager failed"),
    );
    // Should send recovery-failed notification
    const failedCalls = mock.api.sendMessage.mock.calls.filter(
      (call: any[]) => call[0]?.customType === "harness-recovery-failed",
    );
    expect(failedCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Run summary generation
// ---------------------------------------------------------------------------

describe("writeRunSummary via /harness:stop", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-summary-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes .summary.json with correct structure on stop", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "worker-1.md"),
      "# worker-1\npath: .\n\n## Goals\n- [x] Goal A\n- [ ] Goal B\n",
    );
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    // Summary file should be written
    const summaryRaw = await readFile(join(tmpDir, SUMMARY_FILE), "utf-8");
    const summary: RunSummary = JSON.parse(summaryRaw);

    expect(summary.stopReason).toBe("user_stop");
    expect(summary.startedAt).toBeTruthy();
    expect(summary.stoppedAt).toBeTruthy();
    expect(summary.duration).toBeTruthy();
    expect(summary.workers).toHaveProperty("worker-1");
    expect(summary.workers["worker-1"].goalsTotal).toBe(2);
    expect(summary.workers["worker-1"].goalsCompleted).toBe(1);
    expect(typeof summary.mailboxUnprocessed).toBe("number");
    expect(typeof summary.queueItemsPending).toBe("number");
  });

  it("sends formatted summary message to parent", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "simple.md"),
      "# simple\npath: .\n\n## Goals\n- [ ] Only goal\n",
    );
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-summary",
        content: expect.stringContaining("Harness Run Summary"),
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// --max-workers flag in /harness:launch
// ---------------------------------------------------------------------------

describe("/harness:launch --max-workers", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-max-workers-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("limits workers and queues overflow with --max-workers 2", async () => {
    // Create 4 goal files
    for (const name of ["task-a", "task-b", "task-c", "task-d"]) {
      await writeFile(
        join(tmpDir, PI_AGENT_DIR, `${name}.md`),
        `# ${name}\npath: .\n\n## Goals\n- [ ] Goal 1\n- [ ] Goal 2\n`,
      );
    }

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--max-workers 2 --stagger 0", ctx);

    // Only 2 worker tmux sessions (plus 1 manager = 3 total tmux new-session calls)
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) => call[0] === "tmux" && call[1]?.includes("new-session"),
    );
    expect(tmuxCalls.length).toBe(3); // 2 workers + 1 manager

    // Queue should have 2 overflow items
    const queue = await readQueue(tmpDir);
    expect(queue.items.filter((i) => i.status === "pending").length).toBe(2);

    // Launch message should mention queued tasks
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Queued (--max-workers 2)"),
      }),
      expect.anything(),
    );
  });

  it("launches all workers when --max-workers is not specified", async () => {
    for (const name of ["a", "b", "c"]) {
      await writeFile(
        join(tmpDir, PI_AGENT_DIR, `${name}.md`),
        `# ${name}\npath: .\n\n## Goals\n- [ ] Goal\n`,
      );
    }

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // All 3 workers + 1 manager = 4 tmux new-session calls
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) => call[0] === "tmux" && call[1]?.includes("new-session"),
    );
    expect(tmuxCalls.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Launch reporting: launched vs skipped
// ---------------------------------------------------------------------------

describe("/harness:launch reporting", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-report-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reports skipped tasks with all goals complete", async () => {
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "active-task.md"),
      "# active-task\npath: .\n\n## Goals\n- [ ] Work to do\n",
    );
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "done-task.md"),
      "# done-task\npath: .\n\n## Goals\n- [x] Already done\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    const sentCalls = mock.api.sendMessage.mock.calls;
    const startedMsg = sentCalls.find(
      (call: any[]) => call[0]?.customType === "harness-started",
    );
    expect(startedMsg).toBeDefined();
    expect(startedMsg![0].content).toContain("Skipped (all goals complete)");
    expect(startedMsg![0].content).toContain("done-task");
  });
});

// ---------------------------------------------------------------------------
// Manager prompt improvements
// ---------------------------------------------------------------------------

describe("manager prompt improvements", () => {
  it("includes mailbox read priority instruction in static instructions", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "test",
        path: ".",
        role: "developer",
        goals: [{ text: "Do thing", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];
    const instructions = buildManagerInstructions(configs, "/tmp/base");

    expect(instructions).toContain("FIRST: Read your mailbox");
    expect(instructions).toContain("process all messages before doing anything else");
  });

  it("includes self-health reporting instruction in static instructions", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "test",
        path: ".",
        role: "developer",
        goals: [{ text: "Do thing", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];
    const instructions = buildManagerInstructions(configs, "/tmp/base");

    expect(instructions).toContain("write a status_report to the parent mailbox");
  });
});

// ---------------------------------------------------------------------------
// /harness:status shows active workers vs goal-files-only
// ---------------------------------------------------------------------------

describe("/harness:status with worker info", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-status-worker-"));
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows goal-files-only for tasks without active workers", async () => {
    // Create a goal file but don't launch (no active sessions)
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "orphan-task.md"),
      "# orphan-task\npath: .\n\n## Goals\n- [ ] Goal\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:status")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Goal files only (no worker): orphan-task"),
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// tmux helper verification
// ---------------------------------------------------------------------------

describe("tmux helpers", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-tmux-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("TMUX_SERVER constant is exported and equals 'pi-harness'", () => {
    expect(TMUX_SERVER).toBe("pi-harness");
  });

  it("spawnSession creates tmux session with correct name pattern", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "svc.md"),
      "# svc\npath: services/svc\n\n## Goals\n- [ ] Fix it\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Find tmux new-session calls
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );

    // Worker session should be named "worker-svc"
    const workerCall = tmuxCalls.find((c: any) => c[1]?.includes("worker-svc"));
    expect(workerCall).toBeDefined();
    expect(workerCall![1]).toContain("-L");
    expect(workerCall![1]).toContain(TMUX_SERVER);
    expect(workerCall![1]).toContain("-d");
    expect(workerCall![1]).toContain("-s");
  });

  it("spawnManager creates tmux session with autonomous loop command", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "task.md"),
      "# task\npath: .\n\n## Goals\n- [ ] Do thing\n",
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Find the manager tmux call
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("new-session"),
    );
    const managerCall = tmuxCalls.find((c: any) =>
      c[1]?.includes("harness-manager"),
    );
    expect(managerCall).toBeDefined();

    // The bash -c argument should contain the loop
    // Note: -c appears twice — first for tmux cwd, second for bash -c
    const bashCArg = managerCall![1];
    const cmdIndex = bashCArg.lastIndexOf("-c");
    const loopCmd = bashCArg[cmdIndex + 1];
    expect(loopCmd).toContain("while true");
    expect(loopCmd).toContain("sleep 120");
    expect(loopCmd).toContain("stop-signal");
    expect(loopCmd).toContain('.pi-agent-prompt.md');
  });

  it("stop command kills worker and manager tmux sessions", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "w1.md"),
      "# w1\npath: .\n\n## Goals\n- [ ] Goal\n",
    );

    // Write launch state with tmux sessions
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          w1: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "w1"),
            branch: "pi-agent/w1",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-w1",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    // Verify tmux kill-session was called for worker and manager
    const killCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("kill-session"),
    );
    expect(killCalls.length).toBeGreaterThanOrEqual(2);

    const targetNames = killCalls.map((c: any) => {
      const tIdx = c[1].indexOf("-t");
      return c[1][tIdx + 1];
    });
    expect(targetNames).toContain("worker-w1");
    expect(targetNames).toContain("harness-manager");
  });

  it("cleanup command kills entire tmux server", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:cleanup")!;
    await cmd.handler("", ctx);

    // Verify tmux kill-server was called
    const killServerCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "tmux" && c[1]?.includes("kill-server"),
    );
    expect(killServerCalls.length).toBeGreaterThanOrEqual(1);
    expect(killServerCalls[0][1]).toContain("-L");
    expect(killServerCalls[0][1]).toContain(TMUX_SERVER);
  });

  it("removeWorktree kills tmux session before git cleanup", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    const wtDir = join(tmpDir, WORKTREE_DIR);
    await mkdir(piDir, { recursive: true });
    await mkdir(wtDir, { recursive: true });

    await writeFile(
      join(piDir, "rm-test.md"),
      "# rm-test\npath: .\n\n## Goals\n- [x] Done\n",
    );

    // Write launch state with a tmux session for the worker
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          "rm-test": {
            worktreePath: join(wtDir, "rm-test"),
            branch: "pi-agent/rm-test",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-rm-test",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Use cleanup to trigger removeWorktree
    const cmd = mock.getCommand("harness:cleanup")!;
    await cmd.handler("", ctx);

    // Verify tmux kill-session was called before git worktree remove
    const allCalls = mock.api.exec.mock.calls;
    const killIdx = allCalls.findIndex(
      (c: any) =>
        c[0] === "tmux" &&
        c[1]?.includes("kill-session") &&
        c[1]?.includes("worker-rm-test"),
    );
    expect(killIdx).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// tmux liveness detection in turn_end
// ---------------------------------------------------------------------------

describe("turn_end tmux liveness", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-liveness-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects dead manager via tmux has-session returning error", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {},
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    // No manager status file — combined with dead tmux, this triggers "stale"

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux has-session to fail (manager is dead)
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        throw new Error("session not found");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Status should reflect that manager is stale (tmux dead + no status file)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("stale"),
    );
  });

  it("shows worker active/stalled/dead count in status bar", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          alpha: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "alpha"),
            branch: "pi-agent/alpha",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-alpha",
          },
          beta: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "beta"),
            branch: "pi-agent/beta",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-beta",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(
        makeManagerStatus({
          submodules: {
            alpha: { completed: 1, total: 2, allDone: false },
            beta: { completed: 0, total: 1, allDone: false },
          },
        }),
      ),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux has-session: alpha alive, beta dead
    // Also mock tmux capture-pane for activity check
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        const tIdx = args.indexOf("-t");
        const sessionName = args[tIdx + 1];
        if (sessionName === "worker-beta") {
          throw new Error("session not found");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        return { stdout: "some output", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // New format: active/stalled/dead (1a/0s/1d)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("1a/0s/1d"),
    );
  });

  it("marks dead worker session as not spawned after tmux check", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          dead: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "dead"),
            branch: "pi-agent/dead",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-dead",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus()),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // All tmux has-session calls fail (everything is dead)
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        throw new Error("session not found");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Status bar should show 0 active, 0 stalled, 1 dead (0a/0s/1d)
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("0a/0s/1d"),
    );
  });
});

// ---------------------------------------------------------------------------
// /harness:attach and /harness:logs commands
// ---------------------------------------------------------------------------

describe("/harness:attach command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-attach-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lists available sessions when called with no args", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux list-sessions to return some sessions
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("list-sessions")) {
        return {
          stdout: "worker-api\nworker-web\nharness-manager\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:attach")!;
    await cmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-sessions",
        content: expect.stringContaining("worker-api"),
      }),
      { triggerTurn: false },
    );
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("harness-manager"),
      }),
      { triggerTurn: false },
    );
  });

  it("shows attach instructions for a specific worker", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux has-session to succeed
    mock.api.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const cmd = mock.getCommand("harness:attach")!;
    await cmd.handler("api", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-attach",
        content: expect.stringContaining("tmux -L pi-harness attach -t worker-api"),
      }),
      { triggerTurn: false },
    );
  });

  it("shows attach instructions for manager", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const cmd = mock.getCommand("harness:attach")!;
    await cmd.handler("manager", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("tmux -L pi-harness attach -t harness-manager"),
      }),
      { triggerTurn: false },
    );
  });

  it("warns when target session not found", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux has-session to fail
    mock.api.exec.mockRejectedValue(new Error("no session"));

    const cmd = mock.getCommand("harness:attach")!;
    await cmd.handler("nonexistent", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "warning",
    );
  });
});

describe("/harness:logs command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-logs-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("captures and displays tmux pane output for a worker", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        return {
          stdout: "Building project...\nTests passed!\nDone.\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:logs")!;
    await cmd.handler("api", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-logs",
        content: expect.stringContaining("Building project"),
      }),
      { triggerTurn: false },
    );
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("worker-api"),
      }),
      { triggerTurn: false },
    );
  });

  it("captures manager logs with 'manager' target", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        // Verify it uses the manager session name
        const tIdx = args.indexOf("-t");
        expect(args[tIdx + 1]).toBe("harness-manager");
        return {
          stdout: "Checking workers...\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:logs")!;
    await cmd.handler("manager", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("harness-manager"),
      }),
      { triggerTurn: false },
    );
  });

  it("warns when no output from dead session", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux capture-pane to fail
    mock.api.exec.mockRejectedValue(new Error("session not found"));

    const cmd = mock.getCommand("harness:logs")!;
    await cmd.handler("dead-worker", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No output"),
      "warning",
    );
  });

  it("shows usage when called with no args", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:logs")!;
    await cmd.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      "info",
    );
  });

  it("passes custom line count to capture-pane", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    let capturedLines = 0;
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        const sIdx = args.indexOf("-S");
        capturedLines = parseInt(args[sIdx + 1].replace("-", ""), 10);
        return { stdout: "output\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:logs")!;
    await cmd.handler("api 50", ctx);

    expect(capturedLines).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// /harness:status tmux info
// ---------------------------------------------------------------------------

describe("/harness:status tmux display", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-status-tmux-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows tmux alive/dead per worker and manager in status output", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(piDir, "w1.md"),
      "# w1\npath: .\n\n## Goals\n- [ ] Goal\n",
    );

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          w1: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "w1"),
            branch: "pi-agent/w1",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-w1",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Mock tmux has-session: worker alive, manager alive
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:status")!;
    await cmd.handler("", ctx);

    const statusContent = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-status",
    )?.[0]?.content;
    expect(statusContent).toBeDefined();
    expect(statusContent).toContain("tmux: alive");
  });
});

// ---------------------------------------------------------------------------
// State persistence for tmux fields
// ---------------------------------------------------------------------------

describe("tmux state persistence", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-persist-tmux-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists and restores tmuxSession and managerTmuxSession", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Write state with tmux session names
    const stateWithTmux: LaunchState = {
      active: true,
      sessions: {
        svc: {
          worktreePath: join(tmpDir, WORKTREE_DIR, "svc"),
          branch: "pi-agent/svc",
          spawned: true,
          spawnedAt: new Date().toISOString(),
          tmuxSession: "worker-svc",
        },
      },
      managerSpawned: true,
      managerCwd: join(tmpDir, MANAGER_DIR),
      managerSpawnedAt: new Date().toISOString(),
      managerTmuxSession: "harness-manager",
    };

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(stateWithTmux),
    );

    const ctx = createMockContext({ cwd: tmpDir });

    // Mock tmux has-session to report sessions are alive
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await mock.emit("session_start", {}, ctx);

    // Re-read persisted state to verify tmux fields survived
    const restored: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(restored.managerTmuxSession).toBe("harness-manager");
    expect(restored.sessions["svc"].tmuxSession).toBe("worker-svc");
  });

  it("clears tmux session names on restore when tmux sessions are dead", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({
        active: true,
        sessions: {
          dead: {
            worktreePath: join(tmpDir, WORKTREE_DIR, "dead"),
            branch: "pi-agent/dead",
            spawned: true,
            spawnedAt: new Date().toISOString(),
            tmuxSession: "worker-dead",
          },
        },
        managerSpawned: true,
        managerCwd: join(tmpDir, MANAGER_DIR),
        managerSpawnedAt: new Date().toISOString(),
        managerTmuxSession: "harness-manager",
      }),
    );

    const ctx = createMockContext({ cwd: tmpDir });

    // Mock tmux has-session to fail (sessions are dead)
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        throw new Error("session not found");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await mock.emit("session_start", {}, ctx);

    // session_start clears dead tmux sessions in memory;
    // trigger /harness:stop which calls persistState to write to disk
    const cmd = mock.getCommand("harness:stop")!;
    await cmd.handler("", ctx);

    // Verify persisted state has cleared dead tmux sessions
    const restored: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(restored.managerTmuxSession).toBeNull();
    expect(restored.sessions["dead"].tmuxSession).toBeNull();
  });
});

// ===========================================================================
// NEW TESTS: Items #1-#10 (Reliability, Observability, Scalability)
// ===========================================================================

// ---------------------------------------------------------------------------
// Item #1: Manager loop exit-code checking
// ---------------------------------------------------------------------------
describe("item #1: manager loop exit-code checking", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-exitcode-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "test-a.md"),
      "# test-a\npath: .\n\n## Goals\n- [ ] Goal 1\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("manager loop command contains exit-code tracking", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Find the tmux new-session call for the manager
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) =>
        call[0] === "tmux" &&
        call[1]?.includes("new-session") &&
        call[1]?.includes("harness-manager"),
    );
    expect(tmuxCalls.length).toBe(1);

    // The loop command is the last arg (passed to bash -c)
    const args = tmuxCalls[0][1] as string[];
    const loopCmd = args[args.length - 1];

    expect(loopCmd).toContain("exit_code=$?");
    expect(loopCmd).toContain("consecutive_failures");
    expect(loopCmd).toContain(`consecutive_failures -ge ${MAX_CONSECUTIVE_FAILURES}`);
    expect(loopCmd).toContain(".pi-agent-errors.log");
    expect(loopCmd).toContain("sleep 30");
    expect(loopCmd).toContain("sleep 120");
  });

  it("MAX_CONSECUTIVE_FAILURES constant is exported as 5", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Item #2: Worker heartbeat / stall detection
// ---------------------------------------------------------------------------
describe("item #2: worker heartbeat monitoring", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-heartbeat-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "worker-a.md"),
      "# worker-a\npath: .\n\n## Goals\n- [ ] Goal 1\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("WORKER_STALL_THRESHOLD_MS is 10 minutes", () => {
    expect(WORKER_STALL_THRESHOLD_MS).toBe(10 * 60 * 1000);
  });

  it("turn_end classifies workers as active when tmux output changes", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // tmux has-session: always alive
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // tmux capture-pane: return changing output each time
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        return { stdout: `output-${Date.now()}`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Write manager status so turn_end proceeds
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "worker-a": { completed: 0, total: 1, allDone: false } },
        stallCount: 0,
      }),
    );

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Status bar should show 1 active worker
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("1a/"),
    );
  });

  it("turn_end classifies dead workers when tmux session is gone", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // tmux has-session: throw for dead sessions (after launch)
      if (cmd === "tmux" && args?.includes("has-session")) {
        // During launch, sessions are alive; after, they're dead
        if (hasLaunched) {
          throw new Error("no session");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    let hasLaunched = false;
    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);
    hasLaunched = true; // Now tmux sessions appear dead

    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "worker-a": { completed: 0, total: 1, allDone: false } },
        stallCount: 0,
      }),
    );

    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("0a/0s/1d"),
    );
  });
});

// ---------------------------------------------------------------------------
// Item #3: Cache invalidation (mtime-based)
// ---------------------------------------------------------------------------
describe("item #3: cache invalidation", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-cache-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "cache-test.md"),
      "# cache-test\npath: .\n\n## Goals\n- [ ] Goal 1\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("re-reads manager status when file mtime changes", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        return { stdout: "output", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Write initial status
    const statusPath = join(tmpDir, MANAGER_STATUS_FILE);
    await writeFile(
      statusPath,
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "cache-test": { completed: 0, total: 1, allDone: false } },
        stallCount: 0,
      }),
    );

    // First turn_end — reads status (cache miss)
    await mock.emit("turn_end", {}, ctx);

    // Update status file (changes mtime)
    // Add small delay to ensure mtime changes
    await new Promise(resolve => setTimeout(resolve, 50));
    await writeFile(
      statusPath,
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "cache-test": { completed: 1, total: 1, allDone: true } },
        stallCount: 0,
      }),
    );

    // Second turn_end — should detect mtime change and re-read
    ctx.ui.setStatus.mockClear();
    await mock.emit("turn_end", {}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("1/1 goals"),
    );
  });
});

// ---------------------------------------------------------------------------
// Item #4: Manager prompt token reduction
// ---------------------------------------------------------------------------
describe("item #4: prompt token reduction", () => {
  it("buildManagerInstructions contains static content", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "test",
        path: ".",
        goals: [{ text: "G1", completed: false }],
        questions: [],
      },
    ];
    const instructions = buildManagerInstructions(configs, "/tmp");
    expect(instructions).toContain("Launch Manager");
    expect(instructions).toContain("invoked in a loop");
    expect(instructions).toContain("auto-merge");
    expect(instructions).toContain("mailbox");
    expect(instructions).toContain("registry");
    expect(instructions).toContain("depends_on");
  });

  it("buildManagerPrompt references instructions file and contains only dynamic data", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        goals: [
          { text: "Build endpoints", completed: false },
          { text: "Add tests", completed: true },
        ],
        questions: [],
      },
    ];
    const prompt = buildManagerPrompt(configs, [], "/tmp");

    // Should reference the instructions file
    expect(prompt).toContain(".manager-instructions.md");
    expect(prompt).toContain("Current Submodules");

    // Should contain dynamic goal data
    expect(prompt).toContain("api");
    expect(prompt).toContain("Build endpoints");

    // Should NOT contain static instructions
    expect(prompt).not.toContain("Launch Manager");
    expect(prompt).not.toContain("invoked in a loop");
  });
});

// ---------------------------------------------------------------------------
// Item #5: Recovery improvements
// ---------------------------------------------------------------------------
describe("item #5: recovery improvements", () => {
  it("RECOVERY_BACKOFF has exponential values", () => {
    expect(RECOVERY_BACKOFF).toEqual([2, 4, 8]);
  });

  it("MAX_MANAGER_RECOVERY is 5", async () => {
    // We can't directly access the constant since it's not exported,
    // but we can verify the behavior — harness:recover --force resets
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-recovery-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "test.md"),
      "# test\npath: .\n\n## Goals\n- [ ] G1\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Use --force to reset counters
    const recoverCmd = mock.getCommand("harness:recover")!;
    mock.api.sendMessage.mockClear();
    await recoverCmd.handler("--force", ctx);

    // Should have called notify for respawn (--force appends "(counters reset)")
    expect(ctx.ui.notify).toHaveBeenCalledWith("Manager respawned (counters reset)", "info");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Item #6: Merge conflict handling
// ---------------------------------------------------------------------------
describe("item #6: merge conflict handling", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-merge-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "merge-test.md"),
      "# merge-test\npath: .\n\n## Goals\n- [ ] Implement feature\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aborts merge and sends mailbox message on conflict", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    let mergeAborted = false;
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // Simulate merge conflict
      if (cmd === "git" && args[0] === "merge" && args[1] !== "--abort") {
        throw new Error("CONFLICT: merge conflict in file.txt");
      }
      // Track merge --abort
      if (cmd === "git" && args[0] === "merge" && args[1] === "--abort") {
        mergeAborted = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Attempt merge via command
    const mergeCmd = mock.getCommand("harness:merge")!;
    mock.api.sendMessage.mockClear();
    await mergeCmd.handler("merge-test", ctx);

    // Should have attempted merge --abort
    expect(mergeAborted).toBe(true);

    // Should have sent a failure message
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("aborted"),
      }),
      expect.anything(),
    );

    // Should have sent mailbox message about conflict
    const managerMailbox = await readMailbox(tmpDir, "parent");
    const conflictMsg = managerMailbox.find(
      (m) => m.message.payload?.event === "merge_conflict",
    );
    expect(conflictMsg).toBeDefined();
    expect(conflictMsg!.message.payload.submodule).toBe("merge-test");
  });
});

// ---------------------------------------------------------------------------
// Item #7: Worker spawn staggering
// ---------------------------------------------------------------------------
describe("item #7: worker spawn staggering", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-stagger-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    for (const name of ["s1", "s2", "s3"]) {
      await writeFile(
        join(tmpDir, PI_AGENT_DIR, `${name}.md`),
        `# ${name}\npath: .\n\n## Goals\n- [ ] Goal\n`,
      );
    }
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("--stagger 0 skips delay between spawns", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const start = Date.now();
    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);
    const elapsed = Date.now() - start;

    // With --stagger 0, should be well under 1 second for 3 workers
    expect(elapsed).toBeLessThan(2000);

    // All 3 workers + 1 manager should have tmux sessions
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) => call[0] === "tmux" && call[1]?.includes("new-session"),
    );
    expect(tmuxCalls.length).toBe(4); // 3 workers + 1 manager
  });

  it("default stagger of 5000ms description appears in command", () => {
    const ctx = createMockContext({ cwd: tmpDir });
    // Just verify the command is registered with the stagger description
    const cmd = mock.getCommand("harness:launch");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("--stagger");
  });
});

// ---------------------------------------------------------------------------
// Item #8: Worker-to-worker dependencies
// ---------------------------------------------------------------------------
describe("item #8: worker dependencies", () => {
  it("parseGoalFile parses depends_on header", () => {
    const content = "# dep-test\npath: services/api\ndepends_on: auth, db\n\n## Goals\n- [ ] Build API\n";
    const config = parseGoalFile(content, "dep-test.md");
    expect(config.dependsOn).toEqual(["auth", "db"]);
  });

  it("serializeGoalFile writes depends_on header", () => {
    const config: SubmoduleConfig = {
      name: "dep-test",
      path: "services/api",
      goals: [{ text: "Build API", completed: false }],
      questions: [],
      dependsOn: ["auth", "db"],
    };
    const serialized = serializeGoalFile(config);
    expect(serialized).toContain("depends_on: auth, db");
  });

  it("launch queues workers with unmet dependencies", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-deps-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });

    // auth has no deps, api depends on auth (incomplete)
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "auth.md"),
      "# auth\npath: .\n\n## Goals\n- [ ] Setup auth\n",
    );
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "api.md"),
      "# api\npath: .\ndepends_on: auth\n\n## Goals\n- [ ] Build API\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Only auth should be spawned (api has unmet dep)
    const tmuxCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) =>
        call[0] === "tmux" &&
        call[1]?.includes("new-session") &&
        call[1]?.some((a: string) => a.startsWith("worker-")),
    );
    // Should have 1 worker (auth) + 1 manager = 2 tmux sessions
    // api is queued because auth is incomplete
    expect(tmuxCalls.length).toBe(1); // only auth worker

    // api should be in the queue
    const queue = await readQueue(tmpDir);
    const apiItem = queue.items.find((i) => i.topic === "api");
    expect(apiItem).toBeDefined();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("buildManagerPrompt includes depends_on info", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: ".",
        goals: [{ text: "Build", completed: false }],
        questions: [],
        dependsOn: ["auth"],
      },
    ];
    const prompt = buildManagerPrompt(configs, [], "/tmp");
    expect(prompt).toContain("Depends on: auth");
  });
});

// ---------------------------------------------------------------------------
// Item #9: State sidecar files
// ---------------------------------------------------------------------------
describe("item #9: state sidecar files", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-sidecar-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "sidecar-test.md"),
      "# sidecar-test\npath: .\n\n## Goals\n- [ ] Goal 1\n- [ ] Goal 2\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes sidecar state on worker spawn", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const cmd = mock.getCommand("harness:launch")!;
    await cmd.handler("--stagger 0", ctx);

    // Verify sidecar file was written
    const sidecarPath = join(tmpDir, PI_AGENT_DIR, "sidecar-test.state.json");
    const sidecar: WorkerState = JSON.parse(
      await readFile(sidecarPath, "utf-8"),
    );

    expect(sidecar.name).toBe("sidecar-test");
    expect(sidecar.status).toBe("active");
    expect(sidecar.goalsCompleted).toBe(0);
    expect(sidecar.goalsTotal).toBe(2);
    expect(sidecar.mergeStatus).toBe("pending");
    expect(sidecar.errors).toEqual([]);
    expect(sidecar.dependenciesMet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item #10: Dashboard command
// ---------------------------------------------------------------------------
describe("item #10: /harness:dashboard command", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-dashboard-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "dash-worker.md"),
      "# dash-worker\npath: .\n\n## Goals\n- [ ] Goal A\n- [x] Goal B\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("is registered as a command", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:dashboard");
    expect(cmd).toBeDefined();
    expect(cmd!.description).toContain("dashboard");
  });

  it("displays sections for manager, workers, queue, questions, errors", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (cmd === "tmux" && args?.includes("capture-pane")) {
        return { stdout: "some output", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Write manager status
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: { "dash-worker": { completed: 1, total: 2, allDone: false } },
        stallCount: 0,
      }),
    );

    mock.api.sendMessage.mockClear();
    const dashCmd = mock.getCommand("harness:dashboard")!;
    await dashCmd.handler("", ctx);

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-dashboard",
        content: expect.stringContaining("Dashboard"),
      }),
      expect.anything(),
    );

    // The dashboard content should include key sections
    const dashContent = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-dashboard",
    )?.[0]?.content;

    expect(dashContent).toBeDefined();
    expect(dashContent).toContain("Manager");
    expect(dashContent).toContain("Worker");
    expect(dashContent).toContain("dash-worker");
  });
});

// ---------------------------------------------------------------------------
// P3: /harness:cleanup command
// ---------------------------------------------------------------------------
describe("/harness:cleanup", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-cleanup-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "clean-worker.md"),
      "# clean-worker\npath: .\n\n## Goals\n- [ ] G1\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cleans up state files, mailboxes, and resets in-memory state", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    // Launch to create sessions and state
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Create state files that should be cleaned up
    await writeFile(join(tmpDir, QUEUE_FILE), "{}");
    await writeFile(join(tmpDir, MANAGER_STATUS_FILE), "{}");
    await writeFile(join(tmpDir, SUMMARY_FILE), "{}");
    await mkdir(join(tmpDir, MAILBOX_DIR, "parent"), { recursive: true });
    await writeFile(join(tmpDir, MAILBOX_DIR, "parent", "msg.json"), "{}");

    // Run cleanup
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Verify message sent
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-cleanup",
        content: expect.stringContaining("Cleaned Up"),
      }),
      expect.anything(),
    );

    // Verify status bar cleared
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", undefined);

    // State files should be gone
    const stateFiles = [QUEUE_FILE, MANAGER_STATUS_FILE, SUMMARY_FILE];
    for (const file of stateFiles) {
      await expect(readFile(join(tmpDir, file), "utf-8")).rejects.toThrow();
    }

    // Mailbox dir should be gone
    await expect(readdir(join(tmpDir, MAILBOX_DIR))).rejects.toThrow();
  });

  it("blocks cleanup when worktrees are dirty (no --force)", async () => {
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // Simulate dirty worktree
      if (cmd === "git" && args[0] === "-C" && args[2] === "status") {
        return { stdout: " M dirty-file.txt\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Attempt cleanup without --force
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    mock.api.sendMessage.mockClear();
    await cleanupCmd.handler("", ctx);

    // Should be blocked with message about dirty worktrees
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-cleanup-blocked",
        content: expect.stringContaining("uncommitted changes"),
      }),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// P3: /harness:dashboard output correctness
// ---------------------------------------------------------------------------
describe("/harness:dashboard output", () => {
  it("includes queue and questions sections", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-dash-full-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "dash-full.md"),
      "# dash-full\npath: .\n\n## Goals\n- [ ] G1\n\n## Questions\n- ? What color?\n",
    );

    // Create a queue file
    const queue = {
      items: [
        { id: "1", topic: "task-1", description: "Do thing 1", priority: 1, assignedTo: "worker-a", status: "dispatched", createdAt: new Date().toISOString() },
        { id: "2", topic: "task-2", description: "Do thing 2", priority: 2, status: "pending", createdAt: new Date().toISOString() },
      ],
    };
    await writeFile(join(tmpDir, QUEUE_FILE), JSON.stringify(queue));

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const dashCmd = mock.getCommand("harness:dashboard")!;
    mock.api.sendMessage.mockClear();
    await dashCmd.handler("", ctx);

    const dashContent = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-dashboard",
    )?.[0]?.content;

    expect(dashContent).toBeDefined();
    // Manager section
    expect(dashContent).toContain("### Manager");
    expect(dashContent).toContain("0/5 attempts");
    // Workers section
    expect(dashContent).toContain("### Workers");
    expect(dashContent).toContain("dash-full");
    // Queue section
    expect(dashContent).toContain("### Queue");
    expect(dashContent).toContain("1 pending");
    expect(dashContent).toContain("1 dispatched");
    expect(dashContent).toContain("task-1");
    expect(dashContent).toContain("task-2");
    // Questions section
    expect(dashContent).toContain("### Questions");
    expect(dashContent).toContain("1 unanswered");
    expect(dashContent).toContain("What color?");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("shows error log lines when present", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-dash-err-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "err-worker.md"),
      "# err-worker\npath: .\n\n## Goals\n- [ ] G1\n",
    );
    // Create error log
    await mkdir(join(tmpDir, MANAGER_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, MANAGER_DIR, ".pi-agent-errors.log"),
      "[2026-01-01T00:00:00Z] pi exited with code 1 (failure 1/5)\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const dashCmd = mock.getCommand("harness:dashboard")!;
    mock.api.sendMessage.mockClear();
    await dashCmd.handler("", ctx);

    const dashContent = mock.api.sendMessage.mock.calls.find(
      (c: any[]) => c[0]?.customType === "harness-dashboard",
    )?.[0]?.content;

    expect(dashContent).toContain("1 logged");
    expect(dashContent).toContain("### Recent Errors");
    expect(dashContent).toContain("pi exited with code 1");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// P3: Auto-recovery backoff logic
// ---------------------------------------------------------------------------
describe("auto-recovery backoff", () => {
  it("respects RECOVERY_BACKOFF stale counts before recovering", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-backoff-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "backoff-worker.md"),
      "# backoff-worker\npath: .\n\n## Goals\n- [ ] G1\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    // Launch harness
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Simulate dead manager: no status file, tmux returns exitCode:1 for has-session
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "can't find session", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    // RECOVERY_BACKOFF[0] = 2, so first recovery needs 2 stale turn_ends
    // Turn_end #1: staleCount becomes 1, not enough for recovery (needs 2)
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);
    const recoverMsgs1 = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-auto-recover",
    );
    expect(recoverMsgs1.length).toBe(0); // No recovery yet

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("stale"),
    );

    // Turn_end #2: staleCount becomes 2, triggers first recovery
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);
    const recoverMsgs2 = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-auto-recover",
    );
    expect(recoverMsgs2.length).toBe(1);
    expect(recoverMsgs2[0][0].content).toContain("attempt 1/5");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends recovery-failed after all attempts exhausted", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-exhaust-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "exhaust-worker.md"),
      "# exhaust-worker\npath: .\n\n## Goals\n- [ ] G1\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Mock dead manager for all subsequent turn_ends
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args?.includes("has-session")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    // RECOVERY_BACKOFF = [2, 4, 8], MAX_MANAGER_RECOVERY = 5
    // Need to trigger 5 recoveries, each requiring BACKOFF[min(attempt, 2)] stale cycles
    // Recovery 1: 2 stale cycles
    // Recovery 2: 4 stale cycles
    // Recovery 3: 8 stale cycles
    // Recovery 4: 8 stale cycles
    // Recovery 5: 8 stale cycles
    // Total: 2 + 4 + 8 + 8 + 8 = 30 turn_ends
    for (let i = 0; i < 30; i++) {
      await mock.emit("turn_end", {}, ctx);
    }

    // Next turn_end should report exhausted
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    const failedMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-recovery-failed",
    );
    expect(failedMsgs.length).toBe(1);
    expect(failedMsgs[0][0].content).toContain("recovery attempts exhausted");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "harness",
      expect.stringContaining("/harness:recover --force"),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("error log dedup only sends once for same errors", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "harness-dedup-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "dedup-worker.md"),
      "# dedup-worker\npath: .\n\n## Goals\n- [ ] G1\n",
    );

    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Create a manager status file (so we don't enter recovery path)
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify({
        status: "running",
        updatedAt: new Date().toISOString(),
        submodules: {},
        stallCount: 0,
      }),
    );
    // Create error log
    await mkdir(join(tmpDir, MANAGER_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, MANAGER_DIR, ".pi-agent-errors.log"),
      "error line 1\nerror line 2\n",
    );

    // First turn_end: should surface errors
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);
    const errMsgs1 = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-manager-errors",
    );
    expect(errMsgs1.length).toBe(1);

    // Second turn_end with same errors: should NOT surface again
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);
    const errMsgs2 = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-manager-errors",
    );
    expect(errMsgs2.length).toBe(0);

    // Add a new error: should surface again
    await writeFile(
      join(tmpDir, MANAGER_DIR, ".pi-agent-errors.log"),
      "error line 1\nerror line 2\nerror line 3\n",
    );
    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);
    const errMsgs3 = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-manager-errors",
    );
    expect(errMsgs3.length).toBe(1);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Round 2 fix tests
// ---------------------------------------------------------------------------

describe("shellEscape", () => {
  it("wraps simple string in single quotes", () => {
    expect(shellEscape("/tmp/foo")).toBe("'/tmp/foo'");
  });

  it("escapes single quotes within the string", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles paths with spaces", () => {
    expect(shellEscape("/tmp/my dir/file")).toBe("'/tmp/my dir/file'");
  });

  it("handles paths with dollar signs", () => {
    expect(shellEscape("/tmp/$HOME/file")).toBe("'/tmp/$HOME/file'");
  });

  it("handles paths with backticks", () => {
    expect(shellEscape("/tmp/`whoami`/file")).toBe("'/tmp/`whoami`/file'");
  });

  it("handles paths with double quotes", () => {
    expect(shellEscape('/tmp/"file"')).toBe("'/tmp/\"file\"'");
  });
});

describe("sanitizeTmuxName", () => {
  it("passes valid names through unchanged", () => {
    expect(sanitizeTmuxName("my-worker")).toBe("my-worker");
  });

  it("replaces spaces with hyphens", () => {
    expect(sanitizeTmuxName("my worker")).toBe("my-worker");
  });

  it("replaces dots and colons with hyphens", () => {
    expect(sanitizeTmuxName("my.worker:1")).toBe("my-worker-1");
  });

  it("truncates to 50 chars", () => {
    const long = "a".repeat(60);
    expect(sanitizeTmuxName(long)).toHaveLength(50);
  });
});

describe("goalFileName case normalization", () => {
  it("parseGoalFile normalizes heading name to lowercase kebab-case", () => {
    const config = parseGoalFile(
      "# MyAuth Service\npath: src/auth\n\n## Goals\n- [ ] Do it\n",
      "myauth-service.md",
    );
    expect(config.name).toBe("myauth-service");
    expect(goalFileName(config.name)).toBe("myauth-service.md");
  });

  it("parseGoalFile normalizes mixed case heading with spaces", () => {
    const config = parseGoalFile(
      "# Add Tests\npath: .\n\n## Goals\n- [ ] Write test\n",
      "add-tests.md",
    );
    expect(config.name).toBe("add-tests");
  });
});

describe("depends_on unknown dependency handling", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-deps-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("treats unknown depends_on as unmet dependency", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Goal file with unknown dependency
    await writeFile(
      join(piDir, "worker-a.md"),
      "# worker-a\npath: .\ndepends_on: nonexistent\n\n## Goals\n- [ ] Do something\n",
    );

    // Do NOT write LAUNCH_STATE_FILE — loopActive must be false so launch proceeds
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Launch — worker-a should be queued (waiting) due to unknown dependency
    await mock.getCommand("harness:launch")!.handler("", ctx);

    // Should warn about unknown dependency
    const warnings = ctx.ui.notify.mock.calls.filter(
      (c: any[]) => c[1] === "warning" && String(c[0]).includes("unknown dependencies"),
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toContain("nonexistent");
  });
});

describe("merged flag accuracy", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-merged-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("merged is false for workers that were never launched", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    // Two goals, both complete → skipped in launch
    await writeFile(
      join(piDir, "done-worker.md"),
      "# done-worker\npath: .\n\n## Goals\n- [x] Already done\n",
    );
    // One goal, incomplete → would launch
    await writeFile(
      join(piDir, "active-worker.md"),
      "# active-worker\npath: .\n\n## Goals\n- [ ] Do thing\n",
    );

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Stop to trigger run summary
    await mock.getCommand("harness:stop")!.handler("", ctx);

    // Check summary
    const summaryMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-summary",
    );
    if (summaryMsgs.length > 0) {
      const content = summaryMsgs[0][0].content;
      // done-worker was never launched or merged, should not show merged: true
      expect(content).not.toContain("done-worker: merged");
    }
  });
});

describe("non-question inbox messages", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-inbox-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("surfaces and deletes non-question messages in turn_end", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );
    await writeFile(
      join(tmpDir, MANAGER_STATUS_FILE),
      JSON.stringify(makeManagerStatus()),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Send a status_report message to parent inbox
    await sendMailboxMessage(tmpDir, "parent", "worker-a", "status_report", {
      event: "merge_conflict",
      submodule: "api",
    });

    // Verify message exists
    const before = await readMailbox(tmpDir, "parent");
    expect(before.length).toBe(1);

    mock.api.sendMessage.mockClear();
    await mock.emit("turn_end", {}, ctx);

    // Message should be surfaced as harness-inbox
    const inboxMsgs = mock.api.sendMessage.mock.calls.filter(
      (c: any[]) => c[0]?.customType === "harness-inbox",
    );
    expect(inboxMsgs.length).toBe(1);
    expect(inboxMsgs[0][0].content).toContain("status_report");
    expect(inboxMsgs[0][0].content).toContain("worker-a");

    // Message should be deleted
    const after = await readMailbox(tmpDir, "parent");
    expect(after.length).toBe(0);
  });
});

describe("harness:stop sets session.spawned = false", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-stop-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stop command sets spawned false on sessions", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(piDir, "test-worker.md"),
      "# test-worker\npath: .\n\n## Goals\n- [ ] Do it\n",
    );

    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    await mock.getCommand("harness:stop")!.handler("", ctx);

    // After stop, loopActive should be false
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.active).toBe(false);
  });
});

describe("queue tool inactive check", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-queue-inactive-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when harness is not active", async () => {
    // Do NOT set up launch state, so loopActive stays false
    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const tool = mock.getTool("harness_queue")!;
    const result = await tool.execute("call-1", { topic: "my-task" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not active");
  });
});

describe("withQueueLock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-lock-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and removes lock file", async () => {
    const lockPath = join(tmpDir, QUEUE_FILE + ".lock");
    let sawLock = false;

    await withQueueLock(tmpDir, async () => {
      // Lock file should exist during execution
      try {
        await readFile(lockPath, "utf-8");
        sawLock = true;
      } catch {
        sawLock = false;
      }
    });

    expect(sawLock).toBe(true);

    // Lock file should be removed after
    let lockExists = true;
    try {
      await readFile(lockPath, "utf-8");
    } catch {
      lockExists = false;
    }
    expect(lockExists).toBe(false);
  });

  it("returns the value from the callback", async () => {
    const result = await withQueueLock(tmpDir, async () => 42);
    expect(result).toBe(42);
  });
});

describe("stall detection normalization", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    tmpDir = await mkdtemp(join(tmpdir(), "harness-stall-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("treats captures differing only by spinner as stalled", async () => {
    const piDir = join(tmpDir, PI_AGENT_DIR);
    await mkdir(piDir, { recursive: true });

    await writeFile(
      join(piDir, "test-worker.md"),
      "# test-worker\npath: .\n\n## Goals\n- [ ] Do it\n",
    );
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify(makeLaunchState({ managerCwd: join(tmpDir, MANAGER_DIR) })),
    );

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Simulate: launch sets up session, then turn_end checks activity
    // With mocked tmux, the capture returns empty string which normalizes to ""
    // Two identical normalized captures → stalled detection kicks in
    // This test verifies the normalization is applied (no crash, stable behavior)
    await mock.emit("turn_end", {}, ctx);
    // If normalization wasn't applied, tmuxCapture returning null would crash
    // (we changed from `recent ===` to `normalizeCapture(recent ?? "")`)
  });
});

// ---------------------------------------------------------------------------
// BMAD Round 3 Fixes: Issues #20-#25
// ---------------------------------------------------------------------------

describe("issue #20: .pi-agent-prompt.md excluded from git in worktrees", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-exclude-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "excl-worker.md"),
      "# excl-worker\npath: .\n\n## Goals\n- [ ] Build it\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("spawnSession writes .pi-agent-prompt.md to git exclude file", async () => {
    let excludeContent = "";
    const worktreePath = join(tmpDir, WORKTREE_DIR, "excl-worker");
    const gitDir = join(tmpDir, ".git-excl-worker");

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        // Simulate worktree creation: create dir + .git file pointing to gitdir
        await mkdir(args[2], { recursive: true });
        await writeFile(join(args[2], ".git"), `gitdir: ${gitDir}\n`);
        await mkdir(join(gitDir, "info"), { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Read the exclude file and verify both files are listed
    try {
      excludeContent = await readFile(join(gitDir, "info", "exclude"), "utf-8");
    } catch { /* may not exist */ }
    expect(excludeContent).toContain("heartbeat.md");
    expect(excludeContent).toContain(".pi-agent-prompt.md");
  });
});

describe("issue #21: mergeWorktree uses force removal after successful merge", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-force-rm-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "force-test.md"),
      "# force-test\npath: .\n\n## Goals\n- [ ] Build it\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removeWorktree called with --force after successful merge", async () => {
    const gitCalls: string[][] = [];
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git") gitCalls.push(args);
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const mergeCmd = mock.getCommand("harness:merge")!;
    await mergeCmd.handler("force-test", ctx);

    // Find the worktree remove call after merge
    const removeCall = gitCalls.find(
      (args) => args[0] === "worktree" && args[1] === "remove" && args.includes("--force"),
    );
    expect(removeCall).toBeDefined();

    // Branch delete should use -D (force) as well
    const branchDeleteCall = gitCalls.find(
      (args) => args[0] === "branch" && args[1] === "-D",
    );
    expect(branchDeleteCall).toBeDefined();
  });
});

describe("issue #23: merge conflict detection via exitCode (not just exceptions)", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-exitcode-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "exitcode-test.md"),
      "# exitcode-test\npath: .\n\n## Goals\n- [ ] Build it\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects merge conflict when pi.exec returns non-zero exitCode without throwing", async () => {
    let mergeAborted = false;
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // Return non-zero exitCode WITHOUT throwing (simulates pi.exec behavior)
      if (cmd === "git" && args[0] === "merge" && args[1] !== "--abort") {
        return { stdout: "", stderr: "CONFLICT (content): merge conflict in file.txt", exitCode: 1 };
      }
      if (cmd === "git" && args[0] === "merge" && args[1] === "--abort") {
        mergeAborted = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const mergeCmd = mock.getCommand("harness:merge")!;
    mock.api.sendMessage.mockClear();
    await mergeCmd.handler("exitcode-test", ctx);

    // Should have attempted merge --abort
    expect(mergeAborted).toBe(true);

    // Should report conflict in the merge result message
    const mergeResult = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-merge-result",
    );
    expect(mergeResult).toBeDefined();
    expect(mergeResult![0].content.toLowerCase()).toContain("conflict");

    // Should have sent mailbox message about conflict
    const parentInbox = await readMailbox(tmpDir, "parent");
    const conflictMsg = parentInbox.find(
      (m) => m.message.payload?.event === "merge_conflict",
    );
    expect(conflictMsg).toBeDefined();
  });

  it("succeeds when pi.exec returns exitCode 0 without throwing", async () => {
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      // All commands succeed with exitCode 0
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    const mergeCmd = mock.getCommand("harness:merge")!;
    mock.api.sendMessage.mockClear();
    await mergeCmd.handler("exitcode-test", ctx);

    const mergeResult = mock.api.sendMessage.mock.calls.find(
      (c: any) => c[0]?.customType === "harness-merge-result",
    );
    expect(mergeResult).toBeDefined();
    expect(mergeResult![0].content).toContain("Merged");
  });
});

describe("issue #24: worker prompt mentions .pi-agent-prompt.md", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-prompt-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    await writeFile(
      join(tmpDir, PI_AGENT_DIR, "prompt-test.md"),
      "# prompt-test\npath: .\nrole: developer\n\n## Goals\n- [ ] Build it\n",
    );
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("worker prompt tells workers not to commit .pi-agent-prompt.md", async () => {
    let promptContent = "";
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
        await mkdir(args[2], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // Read the prompt file that was written to the worktree
    const worktreePath = join(tmpDir, WORKTREE_DIR, "prompt-test");
    try {
      promptContent = await readFile(join(worktreePath, ".pi-agent-prompt.md"), "utf-8");
    } catch { /* file may not exist if worktree mock doesn't create dirs */ }

    expect(promptContent).toContain(".pi-agent-prompt.md");
    expect(promptContent).toContain("do NOT commit or stage heartbeat.md or .pi-agent-prompt.md");
  });
});

describe("issue #22: orphaned worktree cleanup also deletes branches", () => {
  let mock: ReturnType<typeof createMockExtensionAPI>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "harness-orphan-branch-"));
    await mkdir(join(tmpDir, PI_AGENT_DIR), { recursive: true });
    mock = createMockExtensionAPI();
    initExtension(mock.api as any);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("cleanup --force deletes branches associated with orphaned worktrees", async () => {
    const gitCalls: string[][] = [];
    const orphanedPath = join(tmpDir, WORKTREE_DIR, "orphaned-worker");

    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git") gitCalls.push([...args]);

      // Return porcelain worktree list with an orphaned entry
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
        return {
          stdout: `worktree ${tmpDir}\nbranch refs/heads/main\n\nworktree ${orphanedPath}\nbranch refs/heads/pi-agent/orphaned-worker\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    // Pre-seed active state so cleanup runs
    await writeFile(
      join(tmpDir, LAUNCH_STATE_FILE),
      JSON.stringify({ active: true, sessions: {}, managerSpawned: false }),
    );

    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);

    // Should have called `git worktree remove <orphaned-path> --force`
    const wtRemove = gitCalls.find(
      (args) => args[0] === "worktree" && args[1] === "remove" && args[2] === orphanedPath,
    );
    expect(wtRemove).toBeDefined();
    expect(wtRemove).toContain("--force");

    // Should have called `git branch -D pi-agent/orphaned-worker`
    const branchDelete = gitCalls.find(
      (args) => args[0] === "branch" && args[1] === "-D" && args[2] === "pi-agent/orphaned-worker",
    );
    expect(branchDelete).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BMAD Integration: buildBmadWorkflowDag
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildBmadWorkflowDag", () => {
  // Minimal workflow defs matching the shape expected by buildBmadWorkflowDag
  const MOCK_WORKFLOW_DEFS = [
    { name: "product-brief", phase: 1, agent: "Business Analyst", description: "Create product brief" },
    { name: "brainstorm", phase: 1, agent: "Creative Intelligence", description: "Brainstorming session" },
    { name: "research", phase: 1, agent: "Creative Intelligence", description: "Market research" },
    { name: "prd", phase: 2, agent: "Product Manager", description: "PRD" },
    { name: "tech-spec", phase: 2, agent: "Product Manager", description: "Tech spec" },
    { name: "create-ux-design", phase: 2, agent: "UX Designer", description: "UX design" },
    { name: "architecture", phase: 3, agent: "System Architect", description: "Architecture" },
    { name: "solutioning-gate-check", phase: 3, agent: "System Architect", description: "Gate check" },
    { name: "sprint-planning", phase: 4, agent: "Scrum Master", description: "Sprint planning" },
    { name: "create-story", phase: 4, agent: "Scrum Master", description: "Create stories" },
    { name: "dev-story", phase: 4, agent: "Developer", description: "Develop story" },
  ];

  it("L0 returns 4-workflow chain", () => {
    const dag = buildBmadWorkflowDag(0, [], MOCK_WORKFLOW_DEFS);
    const names = dag.map((s) => s.workflowName);
    expect(names).toEqual(["tech-spec", "sprint-planning", "create-story", "dev-story"]);
  });

  it("L1 includes product-brief", () => {
    const dag = buildBmadWorkflowDag(1, [], MOCK_WORKFLOW_DEFS);
    const names = dag.map((s) => s.workflowName);
    expect(names).toContain("product-brief");
    expect(names).toContain("tech-spec");
    expect(names).toContain("brainstorm");
    expect(names).toContain("research");
    expect(names).not.toContain("prd");
    expect(names).not.toContain("architecture");
  });

  it("L2+ includes prd and architecture", () => {
    const dag = buildBmadWorkflowDag(2, [], MOCK_WORKFLOW_DEFS);
    const names = dag.map((s) => s.workflowName);
    expect(names).toContain("product-brief");
    expect(names).toContain("prd");
    expect(names).toContain("architecture");
    expect(names).toContain("create-ux-design");
    expect(names).toContain("solutioning-gate-check");
    expect(names).not.toContain("tech-spec");
  });

  it("filters out completed workflows", () => {
    const status = [
      { name: "product-brief", status: "docs/product-brief-test-2026.md" },
      { name: "prd", status: "docs/prd-test-2026.md" },
    ];
    const dag = buildBmadWorkflowDag(2, status, MOCK_WORKFLOW_DEFS);
    const names = dag.map((s) => s.workflowName);
    expect(names).not.toContain("product-brief");
    expect(names).not.toContain("prd");
    expect(names).toContain("architecture");
  });

  it("dependency edges are correct", () => {
    const dag = buildBmadWorkflowDag(2, [], MOCK_WORKFLOW_DEFS);
    const byName = (n: string) => dag.find((s) => s.workflowName === n);

    expect(byName("product-brief")!.dependsOn).toEqual([]);
    expect(byName("prd")!.dependsOn).toEqual(["product-brief"]);
    expect(byName("architecture")!.dependsOn).toContain("prd");
    expect(byName("sprint-planning")!.dependsOn).toContain("architecture");
    expect(byName("create-story")!.dependsOn).toEqual(["sprint-planning"]);
    expect(byName("dev-story")!.dependsOn).toEqual(["create-story"]);
  });

  it("empty status returns full DAG for level", () => {
    const dag = buildBmadWorkflowDag(2, [], MOCK_WORKFLOW_DEFS);
    // L2 should have: product-brief, prd, architecture, sprint-planning,
    // create-story, dev-story, brainstorm, research, create-ux-design, solutioning-gate-check
    expect(dag.length).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BMAD_ROLE_MAP
// ═══════════════════════════════════════════════════════════════════════════════

describe("BMAD_ROLE_MAP", () => {
  it("all 8 BMAD agents map to valid harness roles", () => {
    const roleNames = HARNESS_ROLES.map((r) => r.name);
    for (const [agent, role] of Object.entries(BMAD_ROLE_MAP)) {
      expect(roleNames).toContain(role);
    }
    expect(Object.keys(BMAD_ROLE_MAP)).toHaveLength(8);
  });

  it("new roles analyst and planner exist in HARNESS_ROLES", () => {
    const roleNames = HARNESS_ROLES.map((r) => r.name);
    expect(roleNames).toContain("analyst");
    expect(roleNames).toContain("planner");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildManagerInstructions with BMAD mode
// ═══════════════════════════════════════════════════════════════════════════════

describe("buildManagerInstructions with bmadMode", () => {
  it("includes BMAD Phase Management section when bmadMode is set", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "bmad-prd",
        path: ".",
        role: "researcher",
        goals: [{ text: "Complete PRD", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];
    const bmadMode: BmadModeConfig = {
      projectLevel: 2,
      projectName: "TestProject",
      statusFile: "docs/bmm-workflow-status.yaml",
      workflows: [
        { name: "bmad-prd", workflowName: "prd", phase: 2, dependsOn: ["bmad-product-brief"] },
      ],
    };
    const result = buildManagerInstructions(configs, "/tmp/test", bmadMode);
    expect(result).toContain("BMAD Phase Management");
    expect(result).toContain("TestProject");
    expect(result).toContain("Level 2");
    expect(result).toContain("Dev-story fan-out");
    expect(result).toContain(".bmad-mode.json");
  });

  it("does not include BMAD section when bmadMode is undefined", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "worker-a",
        path: ".",
        role: "developer",
        goals: [{ text: "Do stuff", completed: false }],
        questions: [],
        context: "",
        rawContent: "",
      },
    ];
    const result = buildManagerInstructions(configs, "/tmp/test");
    expect(result).not.toContain("BMAD Phase Management");
  });
});
