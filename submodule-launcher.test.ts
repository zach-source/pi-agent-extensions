import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  buildManagerPrompt,
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
  type SubmoduleConfig,
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

describe("buildManagerPrompt", () => {
  it("includes goal content and instructions", () => {
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

    expect(prompt).toContain("Launch Manager");
    expect(prompt).toContain("api");
    expect(prompt).toContain("Fix auth");
    expect(prompt).toContain("Add tests");
    expect(prompt).toContain("pi-agent/api");
    expect(prompt).toContain("services/api");
    expect(prompt).toContain("manager-status.json");
    expect(prompt).toContain("stop-signal");
    expect(prompt).toContain("Auto-Merge");
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

    // Should set "done" status
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("harness", "harness: done");

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
      "harness: stopped",
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

  it("spawns workers and manager, creates .manager/ dir and heartbeat.md", async () => {
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
    await cmd.handler("", ctx);

    // Should have called exec for worktree creation, worker pi sessions, and manager pi session
    const execCalls = mock.api.exec.mock.calls;
    const gitCalls = execCalls.filter((c: any) => c[0] === "git");
    const piCalls = execCalls.filter((c: any) => c[0] === "pi");

    expect(gitCalls.length).toBeGreaterThanOrEqual(2); // 2 worktree adds
    expect(piCalls.length).toBe(3); // 2 worker sessions + 1 manager session

    // Verify manager pi.exec call has correct cwd
    const managerCall = piCalls.find((c: any) =>
      c[2]?.cwd?.includes(".manager"),
    );
    expect(managerCall).toBeDefined();
    expect(managerCall![2].background).toBe(true);

    // Verify .manager/ directory was created with heartbeat.md
    const heartbeat = await readFile(
      join(tmpDir, MANAGER_DIR, "heartbeat.md"),
      "utf-8",
    );
    expect(heartbeat).toContain("Launch Manager");
    expect(heartbeat).toContain("interval: 2m");
    expect(heartbeat).toContain("Monitor submodule worker progress");

    // Should show harness-started message
    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-started",
        content: expect.stringContaining("api"),
      }),
      { triggerTurn: false },
    );

    // Verify state includes manager fields
    const state: LaunchState = JSON.parse(
      await readFile(join(tmpDir, LAUNCH_STATE_FILE), "utf-8"),
    );
    expect(state.managerSpawned).toBe(true);
    expect(state.managerCwd).toContain(".manager");
    expect(state.managerSpawnedAt).not.toBeNull();
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
    await cmd.handler("", ctx);

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
    await cmd.handler("", ctx);

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

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("stop signal"),
      "info",
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

  it("runs git submodule status and creates scaffold", async () => {
    mock.api.exec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "submodule") {
        return {
          stdout: " abc123 services/api (v1.0)\n def456 apps/web (v2.0)\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const ctx = createMockContext({ cwd: tmpDir });
    await mock.emit("session_start", {}, ctx);

    const cmd = mock.getCommand("harness:init")!;
    await cmd.handler("", ctx);

    // Check that goal files were created
    const apiGoal = await readFile(
      join(tmpDir, PI_AGENT_DIR, "api.md"),
      "utf-8",
    );
    expect(apiGoal).toContain("# api");
    expect(apiGoal).toContain("path: services/api");

    const webGoal = await readFile(
      join(tmpDir, PI_AGENT_DIR, "web.md"),
      "utf-8",
    );
    expect(webGoal).toContain("# web");
    expect(webGoal).toContain("path: apps/web");

    expect(mock.api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "harness-init",
        content: expect.stringContaining("2 submodule(s)"),
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

    // Should have spawned a new manager
    const piCalls = mock.api.exec.mock.calls.filter((c: any) => c[0] === "pi");
    expect(piCalls.length).toBe(1);
    expect(piCalls[0][2].cwd).toContain(".manager");
    expect(piCalls[0][2].background).toBe(true);

    // Should have created heartbeat.md
    const heartbeat = await readFile(
      join(tmpDir, MANAGER_DIR, "heartbeat.md"),
      "utf-8",
    );
    expect(heartbeat).toContain("Launch Manager");

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
    await cmd.handler("", ctx);

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
    await cmd.handler("", ctx);

    // Find the worker pi call (not the manager)
    const piCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "pi" && !c[2]?.cwd?.includes(".manager"),
    );
    expect(piCalls.length).toBe(1);

    const prompt = piCalls[0][1][1]; // pi -p <prompt>
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
    await cmd.handler("", ctx);

    const piCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "pi" && !c[2]?.cwd?.includes(".manager"),
    );
    expect(piCalls.length).toBe(1);

    const prompt = piCalls[0][1][1];
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
  it("includes questions and stall-exemption", () => {
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
    expect(prompt).toContain("unanswered questions");
    expect(prompt).toContain("NOT stalled");
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
    await cmd.handler("", ctx);

    const piCalls = mock.api.exec.mock.calls.filter(
      (c: any) => c[0] === "pi" && !c[2]?.cwd?.includes(".manager"),
    );
    expect(piCalls.length).toBe(1);

    const prompt = piCalls[0][1][1]; // pi -p <prompt>
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
    expect(id1).toMatch(/^\d+-[a-z0-9]{4}$/);
    expect(id2).toMatch(/^\d+-[a-z0-9]{4}$/);
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

    expect(id).toMatch(/^\d+-[a-z0-9]{4}$/);

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

describe("buildManagerPrompt with mailbox", () => {
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

    const prompt = buildManagerPrompt(
      configs,
      [{ name: "api", branch: "pi-agent/api", worktreePath: "/tmp/wt/api" }],
      "/tmp/project",
    );

    expect(prompt).toContain("## Work Queue");
    expect(prompt).toContain(".queue.json");
    expect(prompt).toContain("## Mailbox");
    expect(prompt).toContain(".mailboxes/manager");
    expect(prompt).toContain("## Worker Registry");
    expect(prompt).toContain(".registry.json");
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
    await cmd.handler("", ctx);

    // Check that pi was called with a prompt containing mailbox instructions
    const piCalls = mock.api.exec.mock.calls.filter(
      (call: any[]) => call[0] === "pi",
    );
    expect(piCalls.length).toBeGreaterThan(0);

    // Find the worker spawn call (not the manager)
    const workerCall = piCalls.find((call: any[]) =>
      call[1][1].includes("## Mailbox"),
    );
    expect(workerCall).toBeDefined();
    const prompt = workerCall![1][1];
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
