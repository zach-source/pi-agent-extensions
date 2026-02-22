/**
 * Trace log inspection test — exercises a full harness lifecycle and dumps
 * the resulting trace log for manual review.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import {
  PI_AGENT_DIR,
  HARNESS_LOG_FILE,
  MANAGER_STATUS_FILE,
  SCOUT_ANALYSIS_FILE,
  type HarnessLogEntry,
  type ScoutAnalysis,
  type ManagerStatusFile,
} from "./submodule-launcher.js";
import initExtension from "./submodule-launcher.js";

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
}

function createMockExtensionAPI() {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, { description: string; handler: Function }>();
  const api = {
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool() {},
    registerCommand(name: string, def: any) { commands.set(name, def); },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    exec: vi.fn().mockImplementation(async (cmd: string, args: string[], opts?: any) => {
      const cwd = opts?.cwd || ".";
      if (cmd === "pi" || cmd === "tmux") return { stdout: "", stderr: "", exitCode: 0 };
      try {
        const quotedArgs = args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`);
        const stdout = execSync(`${cmd} ${quotedArgs.join(" ")}`, { cwd, encoding: "utf-8", timeout: 10_000 });
        return { stdout, stderr: "", exitCode: 0 };
      } catch (e: any) {
        return { stdout: e.stdout?.toString() || "", stderr: e.stderr?.toString() || "", exitCode: e.status || 1 };
      }
    }),
  };
  return {
    api,
    async emit(event: string, eventData: any, ctx: any) {
      for (const fn of handlers.get(event) ?? []) await fn(eventData, ctx);
    },
    getCommand(name: string) { return commands.get(name); },
  };
}

function createMockContext(cwd: string) {
  return {
    cwd,
    isIdle: vi.fn().mockReturnValue(true),
    getContextUsage: vi.fn().mockReturnValue({ tokens: 8000, contextWindow: 200000, percent: 4 }),
    newSession: vi.fn(),
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

describe("trace log inspection", { timeout: 60_000 }, () => {
  let baseDir: string;
  let repo: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "trace-full-"));
    repo = join(baseDir, "project");
    git(`init ${repo}`, baseDir);
    execSync('echo "# Test" > README.md && git add . && git commit -m "init"', { cwd: repo, shell: "/bin/bash" });
  });

  afterAll(async () => {
    try { execSync("tmux -L pi-harness kill-server 2>/dev/null"); } catch {}
    await rm(baseDir, { recursive: true, force: true });
  });

  it("full lifecycle dump", async () => {
    const mock = createMockExtensionAPI();
    initExtension(mock.api as any);
    const ctx = createMockContext(repo);

    // 1. session_start
    await mock.emit("session_start", {}, ctx);

    // 2. Add tasks
    const addCmd = mock.getCommand("harness:add")!;
    await addCmd.handler("auth-api Implement JWT auth, Add refresh tokens, Write tests", ctx);
    await addCmd.handler("data-layer Set up Prisma schema, Write repository layer", ctx);

    // 3. Launch
    const launchCmd = mock.getCommand("harness:launch")!;
    await launchCmd.handler("--stagger 0", ctx);

    // 4. Simulate tool calls
    await mock.emit("tool_call", { toolName: "harness_status", input: { verbose: true } }, ctx);
    await mock.emit("tool_call", { toolName: "read_file", input: { path: "/src/auth.ts" } }, ctx);

    // 5. Write config change to trigger config.reload
    await writeFile(join(repo, ".pi-agent/.harness-config.json"), JSON.stringify({ maxWorkers: 5 }));

    // 6. Write manager status so turn_end processes
    await writeFile(join(repo, MANAGER_STATUS_FILE), JSON.stringify({
      status: "running",
      updatedAt: new Date().toISOString(),
      submodules: { "auth-api": { completed: 1, total: 3, allDone: false } },
      stallCount: 0,
    } satisfies ManagerStatusFile));

    // 7. turn_end
    await mock.emit("turn_end", {}, ctx);

    // 8. agent_end
    await mock.emit("agent_end", {}, ctx);

    // 9. session_shutdown
    await mock.emit("session_shutdown", {}, {});

    await new Promise((r) => setTimeout(r, 300));

    // ---- Read and display the trace log ----
    const raw = await readFile(join(repo, HARNESS_LOG_FILE), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as HarnessLogEntry);

    console.log("\n" + "=".repeat(80));
    console.log(`TRACE LOG DUMP (${entries.length} entries)`);
    console.log("=".repeat(80));
    for (const e of entries) {
      const time = e.ts.replace(/T/, " ").replace(/\.\d+Z$/, "Z");
      const lvl = e.level.toUpperCase().padEnd(5);
      const data = e.data ? " " + JSON.stringify(e.data) : "";
      console.log(`[${time}] [${lvl}] ${e.event}${data}`);
    }

    // Event prefix counts
    const eventCounts: Record<string, number> = {};
    for (const e of entries) {
      const prefix = e.event.split(".")[0];
      eventCounts[prefix] = (eventCounts[prefix] || 0) + 1;
    }
    console.log("\n--- Event Prefix Counts ---");
    for (const [prefix, count] of Object.entries(eventCounts).sort()) {
      console.log(`  ${prefix}: ${count}`);
    }

    // Level counts
    const levelCounts: Record<string, number> = {};
    for (const e of entries) {
      levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
    }
    console.log("\n--- Level Counts ---");
    for (const [level, count] of Object.entries(levelCounts).sort()) {
      console.log(`  ${level}: ${count}`);
    }

    // All unique event names
    const uniqueEvents = [...new Set(entries.map((e) => e.event))].sort();
    console.log("\n--- Unique Event Names ---");
    for (const ev of uniqueEvents) {
      console.log(`  ${ev}`);
    }
    console.log("=".repeat(80) + "\n");

    // Assertions — should have meaningful coverage
    expect(entries.length).toBeGreaterThan(10);
    expect(uniqueEvents).toContain("session.start");
    expect(uniqueEvents).toContain("session.shutdown");
    expect(uniqueEvents).toContain("tool.call");
    expect(uniqueEvents).toContain("turn.end");
    expect(uniqueEvents).toContain("agent.end");
    expect(uniqueEvents).toContain("worker.worktree.created");
    expect(uniqueEvents).toContain("worker.spawn");
    expect(uniqueEvents).toContain("manager.spawn");
    expect(uniqueEvents).toContain("state.persist");
    expect(uniqueEvents).toContain("config.reload");

    // Clean up
    const cleanupCmd = mock.getCommand("harness:cleanup")!;
    await cleanupCmd.handler("--force", ctx);
  });
});
