import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseGoalFile,
  serializeGoalFile,
  buildProgressSummary,
  buildManagerPrompt,
  readManagerStatus,
  MAX_STALLS,
  CONTEXT_CRITICAL_PERCENT,
  PI_AGENT_DIR,
  WORKTREE_DIR,
  LAUNCH_STATE_FILE,
  MANAGER_DIR,
  MANAGER_STATUS_FILE,
  STOP_SIGNAL_FILE,
  MANAGER_STALE_THRESHOLD_MS,
  type SubmoduleConfig,
  type SubmoduleGoal,
  type LaunchState,
  type ManagerStatusFile,
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
});

describe("serializeGoalFile", () => {
  it("round-trips a parsed config", () => {
    const original: SubmoduleConfig = {
      name: "web-client",
      path: "apps/web",
      goals: [
        { text: "Implement login form", completed: false },
        { text: "Add unit tests", completed: true },
      ],
      context: "React + TypeScript frontend.",
      rawContent: "",
    };

    const serialized = serializeGoalFile(original);
    const parsed = parseGoalFile(serialized, "web-client.md");

    expect(parsed.name).toBe(original.name);
    expect(parsed.path).toBe(original.path);
    expect(parsed.goals).toEqual(original.goals);
    expect(parsed.context).toBe(original.context);
  });

  it("omits ## Context section when empty", () => {
    const config: SubmoduleConfig = {
      name: "test",
      path: "test/path",
      goals: [{ text: "Do something", completed: false }],
      context: "",
      rawContent: "",
    };

    const serialized = serializeGoalFile(config);
    expect(serialized).not.toContain("## Context");
  });
});

describe("buildProgressSummary", () => {
  it("shows per-submodule progress", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        goals: [
          { text: "Fix auth", completed: true },
          { text: "Add caching", completed: false },
        ],
        context: "",
        rawContent: "",
      },
      {
        name: "web",
        path: "apps/web",
        goals: [{ text: "Login form", completed: false }],
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
        goals: [{ text: "Done", completed: true }],
        context: "",
        rawContent: "",
      },
    ];

    const summary = buildProgressSummary(configs);
    expect(summary).toContain("DONE");
    expect(summary).toContain("All submodule goals are complete");
  });
});

describe("buildManagerPrompt", () => {
  it("includes goal content and instructions", () => {
    const configs: SubmoduleConfig[] = [
      {
        name: "api",
        path: "services/api",
        goals: [
          { text: "Fix auth", completed: false },
          { text: "Add tests", completed: true },
        ],
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
        goals: [{ text: "Task", completed: false }],
        context: "",
        rawContent: "",
      },
    ];

    const prompt = buildManagerPrompt(configs, [], "/tmp/project");
    expect(prompt).toContain("No active session");
    expect(prompt).toContain("web");
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
  });

  it("registers expected commands", () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);

    for (const cmd of [
      "harness:launch",
      "harness:status",
      "harness:stop",
      "harness:init",
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
  });
});
