# Harness: Multi-Agent Orchestration for Pi

The Harness extension turns a single Pi session into a parallel workforce. It uses **git worktrees** for isolation, **tmux sessions** for concurrent execution, and a dedicated **manager agent** to monitor progress, auto-merge completed work, and dispatch queued tasks.

## Quick Start

```
# 1. Add tasks with goals
/harness:add auth-api Implement JWT auth, Add refresh token endpoint, Write integration tests
/harness:add data-layer Set up Prisma schema, Write repository layer, Add seed script

# 2. Launch workers + manager
/harness:launch
```

That's it — two steps. Each task gets its own git worktree and tmux session. A manager agent monitors progress, auto-merges completed branches, and dispatches queued work.

> **Note:** `/harness:init` exists but is optional — `/harness:add` and `/harness:launch` auto-create the `.pi-agent/` directory.

## How It Works

```
Your Pi session (parent)
  │
  ├── .pi-agent/
  │   ├── auth-api.md          ← goal file (checklist)
  │   ├── data-layer.md        ← goal file
  │   ├── .manager-status.json ← written by manager
  │   ├── .registry.json       ← active worker metadata
  │   ├── .queue.json           ← pending work items
  │   ├── worktrees/
  │   │   ├── auth-api/        ← isolated git worktree
  │   │   └── data-layer/      ← isolated git worktree
  │   └── mailbox/
  │       ├── parent/           ← messages to you
  │       ├── manager/          ← messages to manager
  │       ├── auth-api/         ← messages to worker
  │       └── data-layer/       ← messages to worker
  │
  ├── tmux: worker-auth-api     ← Pi session running in worktree
  ├── tmux: worker-data-layer   ← Pi session running in worktree
  └── tmux: manager             ← Pi session monitoring all workers
```

**Isolation**: Each worker runs on its own git branch in its own worktree. Workers cannot interfere with each other or with your main branch.

**Manager**: An autonomous Pi session that reads goal files every heartbeat cycle, tracks progress, auto-merges completed branches back to main, and dispatches queued work to idle workers.

**Mailbox**: Workers and the manager communicate via JSON message files. Workers can ask questions, the manager can send directives, and you can read the parent inbox.

## Commands

### Lifecycle

| Command | Description |
|---------|-------------|
| `/harness:init` | Scaffold `.pi-agent/` directory with mailbox structure |
| `/harness:launch` | Create worktrees, spawn workers + manager. Flags: `--max-workers N`, `--stagger N`, `--model-routes <path>`, `--heartbeat <ms>`, `--dashboard` |
| `/harness:auto [objective]` | Autonomous: scout → plan → execute → re-scout loop |
| `/harness:stop` | Gracefully stop all workers and the manager |
| `/harness:cleanup` | Remove all worktrees, branches, and state files |

### Task Management

| Command | Description |
|---------|-------------|
| `/harness:add <name> [goals...]` | Create a task with comma-separated goals |
| `/harness:discover [--focus <areas>]` | Interactive repo assessment — scans your repo and interviews you to create tasks |
| `/harness:queue <topic> [goals...]` | Add work to the dispatch queue |

### Monitoring

| Command | Description |
|---------|-------------|
| `/harness:status` | Show progress of all workers |
| `/harness:dashboard` | Comprehensive view: workers, queue, health |
| `/harness:logs <name\|manager> [lines]` | Show recent tmux output |
| `/harness:attach <name\|manager>` | Attach to a tmux session |
| `/harness:inbox` | Read messages in the parent mailbox |

### Recovery

| Command | Description |
|---------|-------------|
| `/harness:merge <name>` | Manually merge a worker's branch |
| `/harness:recover` | Respawn a stale or dead manager |

### Advanced

| Command | Description |
|---------|-------------|
| `/harness:forget` | Clear the persistent memory store |
| `/harness:schedule <sub>` | Manage scheduled runs (add/list/remove/enable/disable) |
| `/harness:sandbox <sub>` | Configure Docker sandboxing (on/off/config) |

## Worker Roles

Roles shape a worker's persona and instructions. Set via `--role` flag or `role:` in goal files.

| Role | Persona | Best For |
|------|---------|----------|
| `developer` | Methodical, TDD-focused | Features, bug fixes (default) |
| `architect` | Design patterns, structure | Refactoring, API design |
| `tester` | Comprehensive coverage | Test suites, edge cases |
| `reviewer` | Quality audit | Security, performance review |
| `researcher` | Exploration, analysis | Investigation, documentation |
| `designer` | UI/UX quality | Components, accessibility |
| `builder` | Platform engineering | CI/CD, tooling, infra |
| `analyst` | Business analysis | Requirements, product vision |
| `planner` | Project planning | Sprint plans, story breakdown |

```
/harness:add security-audit --role reviewer Review auth module for OWASP top 10
/harness:add api-design --role architect Design REST API for user service
```

### Tool Access Policies

Roles with restricted tool access receive advisory policy instructions injected into their worker prompt. This shapes LLM behavior to prevent unintended modifications.

| Role | Mode | Restriction |
|------|------|-------------|
| `researcher` | read-only | No file creation/modification/deletion |
| `reviewer` | targeted-write | Targeted fixes only, no refactoring |
| `analyst` | read-only | Read + BMAD document tools only |
| `planner` | read-only | Read + BMAD planning tools only |
| `architect` | targeted-write | Structural changes only, no feature implementation |
| `developer`, `builder`, `tester`, `designer` | full | No restrictions |

Policies are advisory (prompt-injected, not system-enforced) but effectively shape worker behavior.

## Goal File Format

Goal files live in `.pi-agent/` and drive worker behavior:

```markdown
# my-task
path: .
role: developer
depends_on: auth-api, data-layer

## Goals
- [ ] Implement user registration endpoint
- [x] Set up database schema
- [ ] Write integration tests

## Questions
- ? Should we use bcrypt or argon2 for password hashing?
- ! What's the session timeout? → 30 minutes

## Context
This task implements the user management API on top of the auth
and data layers built by the other workers.
```

**Fields**:
- `path`: Working directory (`.` for repo root)
- `role`: Worker role (optional, defaults to `developer`)
- `depends_on`: Comma-separated task names that must complete first
- `Goals`: Checkbox list — workers mark `[x]` as they complete items
- `Questions`: Workers write `- ?` questions; you answer with `- !`

## Dependencies

Tasks can declare dependencies on other tasks:

```
/harness:add core-lib Build shared types, Create utility functions
/harness:add api-server --role developer Build REST endpoints, Add middleware
```

Then edit `.pi-agent/api-server.md` to add:
```
depends_on: core-lib
```

When launched, `api-server` will be queued until `core-lib` completes and merges.

## Dynamic Work Queue

Add work items while the harness is running:

```
/harness:queue --role tester --priority 5 test-coverage Write unit tests for auth module
```

The manager will dispatch queued items to idle workers or spawn new workers as capacity allows.

## Launch Options

```
# Limit concurrent workers (default: unlimited)
/harness:launch --max-workers 3

# Stagger worker spawns (default: 5000ms)
/harness:launch --stagger 10000

# Use custom model routing
/harness:launch --model-routes ./routes.json

# Set heartbeat interval (default: 60000ms)
/harness:launch --heartbeat 90000

# Enable web dashboard on port 3847
/harness:launch --dashboard

# All flags above also work on /harness:bmad:
/harness:bmad --max-workers 3 --model-routes ./routes.json --heartbeat 90000 --dashboard
```

## Monitoring Workers

```
# Quick status check
/harness:status

# Full dashboard with queue and health info
/harness:dashboard

# See what a worker is doing
/harness:logs auth-api 50

# Check messages from workers
/harness:inbox
```

## BMAD Integration

The harness can run the entire [BMAD Method](https://github.com/bmad-method) — a 4-phase software development methodology — as parallel workers with dependency enforcement.

### Quick Start (1 step)

```
/harness:bmad --init --max-workers 3 --model-routes ./routes.json --heartbeat 90000 --dashboard
```

The `--init` flag auto-detects your project name (from `package.json`, `pyproject.toml`, or directory name), project type, and scaffolds `bmad/config.yaml` + `docs/bmm-workflow-status.yaml` non-interactively. Defaults to level 2; override with `--level N`.

`/harness:bmad` supports the same advanced flags as `/harness:launch`: `--model-routes`, `--heartbeat`, and `--dashboard`.

### Prerequisites (without --init)

Initialize BMAD in your project first:
```
/bmad-init
```

This creates `bmad/config.yaml` and `docs/bmm-workflow-status.yaml` via an interactive conversation.

### Running BMAD via Harness

```
# Basic
/harness:bmad --max-workers 3

# With advanced features
/harness:bmad --max-workers 3 --model-routes ./routes.json --heartbeat 90000 --dashboard
```

This command:

1. Reads your BMAD config and workflow status
2. Builds a dependency DAG of remaining workflows
3. Assigns each workflow to a specialized worker role
4. Launches independent workflows in parallel
5. Queues dependent workflows for automatic dispatch
6. Spawns a BMAD-aware manager that unblocks phases as work completes

### BMAD Workflow Phases

| Phase | Workflows | Role |
|-------|-----------|------|
| 1 - Analysis | product-brief, brainstorm, research | analyst, researcher |
| 2 - Planning | prd, tech-spec, create-ux-design | researcher, designer |
| 3 - Solutioning | architecture, solutioning-gate-check | architect |
| 4 - Execution | sprint-planning, create-story, dev-story | planner, developer |

The dependency DAG varies by project level:

- **Level 0**: tech-spec → sprint-planning → create-story → dev-story
- **Level 1**: product-brief → tech-spec → sprint-planning → stories
- **Level 2+**: product-brief → prd → architecture → sprint-planning → stories

Workers at the same phase with no interdependencies run in parallel.

### BMAD Worker Autonomy

BMAD workers run without user interaction. They:
- Read existing project documents for context
- Make reasonable decisions based on available information
- Save documents via `bmad_save_document` and `bmad_update_status`
- Write questions to goal files only when truly blocked
- Mark goals complete for the manager to track

### Skipping Workflows

To skip a workflow, set its status to `"skipped"` in `docs/bmm-workflow-status.yaml`:

```yaml
- name: brainstorm
  phase: 1
  status: "skipped"
```

Skipped workflows are treated as complete — they won't launch, and downstream dependencies are satisfied.

## Architecture

### Tmux Sessions

All sessions run under the `pi-harness` tmux server:

```bash
# List all harness sessions
tmux -L pi-harness ls

# Attach to a worker
tmux -L pi-harness attach -t worker-auth-api

# Attach to manager
tmux -L pi-harness attach -t manager
```

### Manager Lifecycle

The manager runs autonomously:

1. **Heartbeat loop**: Reads goal files every cycle
2. **Progress tracking**: Counts completed vs total goals per worker
3. **Auto-merge**: When all goals are `[x]`, merges the worker's branch
4. **Queue dispatch**: Assigns pending queue items to idle workers
5. **Stall detection**: Detects workers with no progress over multiple cycles
6. **Stop signal**: Checks for `.pi-agent/.stop` and shuts down gracefully

### Deterministic Operations

Three safety-critical operations run as deterministic code in `turn_end`, independent of the manager LLM:

1. **Goal Counting** — Total/completed goals and unanswered questions are derived directly from goal file parsing, not from the manager's status JSON. This eliminates miscounting due to stale or incorrect manager state.

2. **Auto-Merge** — When a worker's goal file shows 100% completion with no unanswered questions, the parent deterministically merges the branch (with branch-existence verification and double-merge guard). The manager prompt serves as a fallback.

3. **Queue Dispatch** — When active workers drop below the max-workers limit and pending queue items exist, the parent deterministically creates worktrees and spawns sessions. Failures fall back to manager-driven dispatch.

All three operations are wrapped in try/catch — on any failure, the manager LLM remains the fallback coordinator.

### State Files

| File | Purpose |
|------|---------|
| `.pi-agent/.manager-status.json` | Manager's view of all workers |
| `.pi-agent/.registry.json` | Active worker metadata |
| `.pi-agent/.queue.json` | Pending work items |
| `.pi-agent/.harness-state.json` | Persisted session state |
| `.pi-agent/.bmad-mode.json` | BMAD phase tracking (when using `/harness:bmad`) |

### Recovery

If the manager dies or stalls:

```
/harness:recover           # Respawn the manager
/harness:recover --force   # Reset recovery counters and respawn
```

The manager can recover up to 5 consecutive failures before requiring `--force`.

## Autonomous Mode

The harness can run fully autonomously: evaluate your codebase, derive high-impact work, execute it in parallel, and re-scout when done — with no user intervention.

### Quick Start

```
# Evaluate codebase and execute highest-impact work
/harness:auto

# With an objective
/harness:auto improve test coverage and fix security issues

# With constraints
/harness:auto --max-workers 4 --max-iterations 5 --focus tests,security
```

### How It Works

```
/harness:auto
  │
  ├── 1. Scout Phase
  │   └── Researcher worker evaluates the codebase
  │       ├── Project structure, test health, code quality
  │       ├── Git history, dependencies, documentation
  │       └── Produces .scout-analysis.json + .scout-report.md
  │
  ├── 2. Execute Phase
  │   └── Workers spawned from scout findings
  │       ├── Each finding → a worker with goals
  │       ├── Sorted by severity (high → medium → low)
  │       └── Manager monitors progress and auto-merges
  │
  └── 3. Re-Scout Phase (repeat until maxIterations)
      └── After all goals complete, scout re-evaluates
          └── Finds new work based on updated codebase
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--max-workers N` | 3 | Maximum concurrent workers |
| `--max-iterations N` | 3 | Scout → execute cycles before stopping |
| `--stagger N` | 5000 | Milliseconds between worker spawns |
| `--focus cat1,cat2` | all | Limit scout to specific categories |
| `--yes` | true | Auto-approve scout findings (default) |

**Focus categories:** `tests`, `quality`, `features`, `docs`, `security`, `performance`, `cleanup`, `bugs`

### Sub-Commands

| Command | Description |
|---------|-------------|
| `/harness:auto approve` | Approve a pending plan (when check-in is enabled) |
| `/harness:auto drop <id>` | Remove a finding from the scout analysis |
| `/harness:auto cancel` | Stop auto mode and clean up all state |

### Examples

```
# General codebase improvement (3 iterations)
/harness:auto

# Targeted: fix tests with 2 workers, 1 pass
/harness:auto --focus tests --max-workers 2 --max-iterations 1 fix failing tests

# Full sweep: 5 workers, 5 iterations
/harness:auto --max-workers 5 --max-iterations 5

# Cancel mid-run
/harness:auto cancel
```

### State Files

| File | Purpose |
|------|---------|
| `.pi-agent/.auto-mode.json` | Auto mode configuration and phase tracking |
| `.pi-agent/.scout-analysis.json` | Structured scout findings (JSON) |
| `.pi-agent/.scout-report.md` | Human-readable scout summary |

These files are automatically cleaned up by `/harness:auto cancel`, `/harness:stop`, and `/harness:cleanup`.

## Advanced Features

### Multi-Model Worker Routing

Route different worker roles to different AI models. Architects and researchers can use a more capable model while developers use the default.

```
# Use a custom model routes file
/harness:launch --model-routes ./my-routes.json

# Example routes file (.pi-agent/.model-routes.json):
[
  { "model": "default", "roles": ["developer", "builder", "tester", "designer"] },
  { "model": "claude-opus-4-6", "roles": ["architect", "analyst", "researcher"] },
  { "model": "claude-opus-4-6", "taskPattern": "^security-" }
]
```

Routes match by `taskPattern` (regex) first, then by `roles`. The `"default"` model uses whatever the system default is.

### Memory/Context Persistence

Workers can persist learnings across harness runs. Memories survive `/harness:cleanup` and are injected into future worker prompts.

```
# Tools available to workers and parent:
harness_remember  — Store a decision, pattern, error, or insight
harness_recall    — Search stored memories by query

# Clear all memories
/harness:forget
```

Memories are stored in `.pi-agent/.memory.json` (max 200 entries, lowest-relevance entries pruned first). Top-5 relevant memories are injected into each worker's prompt as "Prior Learnings".

Memory search uses **BM25 scoring** for term-frequency and inverse-document-frequency weighting, with bonuses for tag matches (+0.3 per matching tag) and category matches (+0.2). Multi-word queries are tokenized and each term contributes independently to the score.

### Heartbeat-Driven Manager

Configure the manager's heartbeat interval instead of using fixed sleep times.

```
# Set heartbeat to 90 seconds
/harness:launch --heartbeat 90000

# Active-hours only (edit .pi-agent/.heartbeat-config.json):
{
  "intervalMs": 60000,
  "stalledThresholdMs": 300000,
  "activeHoursOnly": true,
  "activeHoursStart": 9,
  "activeHoursEnd": 17
}
```

### Worker Health Monitoring & Auto-Recovery

Dead workers with incomplete goals are automatically respawned (up to 3 times per worker with 30-second cooldown). Recovery status is shown in the status bar with an `/r` suffix.

```
harness: 4/8 goals, running, 2a/0s/0d/1r
                                       ^^ 1 recovered
```

Recovery attempts are tracked per worker in the sidecar state files. Workers that have exhausted all recovery attempts are reported to the parent mailbox.

### Inter-Agent Session Communication

Workers can send messages directly to other workers for peer-to-peer coordination.

```
# Tools available to workers and parent:
harness_send_message  — Send to a specific worker, manager, or parent
harness_read_messages — Read messages from any actor's mailbox
```

Message types align with the mailbox protocol: `directive` (default), `question`, `answer`, `status_report`, `ack`.

System-generated messages (e.g. recovery notifications, merge conflict alerts) are tagged with `system: true` to distinguish them from worker-authored messages.

Worker prompts include a list of active workers they can message.

### Self-Improving Worker Templates

Workers rate their prompt quality after each run. Low-rated templates automatically get adjustments applied to future workers with the same role.

```
# Workers call harness_rate_template with:
{ "rating": 1-5, "feedback": "...", "adjustments": ["Be more specific about..."],
  "role": "developer",      // optional: auto-detected if omitted
  "taskName": "auth-api"    // optional: auto-detected if omitted
}
```

The optional `role` and `taskName` fields enable per-role and per-task tracking. If omitted, they default to `"unknown"`.

Ratings are stored in `.pi-agent/.template-store.json`. When a role's average rating drops below 3, adjustment suggestions from low-rated entries are injected into future prompts.

### Cron-Scheduled Autonomous Runs

Schedule `/harness:auto` runs at specific times.

```
# Add a nightly cleanup run at 2am
/harness:schedule add --at 02:00 --focus tests,quality --max-workers 2 "nightly cleanup"

# Add a daily general improvement
/harness:schedule add --at daily "general improvement"

# List all schedules
/harness:schedule list

# Disable/enable/remove
/harness:schedule disable <id>
/harness:schedule enable <id>
/harness:schedule remove <id>
```

Schedules support `hourly`, `daily`, `weekly`, or `HH:MM` timing. Due schedules are detected on `session_start` and surfaced as notifications. **Note:** `HH:MM` schedules use local time (the system timezone where the harness runs).

### Sandboxed Worker Execution

Optionally run workers inside Docker containers for isolation.

```
# Enable sandbox mode
/harness:sandbox on

# Disable
/harness:sandbox off

# View current config
/harness:sandbox config
```

When enabled, workers run inside containers with the worktree mounted as a volume. Default image: `node:20-slim`.

### Webhook/Event Triggers

External systems can trigger harness actions by writing JSON files to `.pi-agent/.triggers/`.

```json
{
  "id": "trigger-1",
  "type": "launch",
  "config": { "maxWorkers": 3 },
  "createdAt": "2024-01-01T00:00:00Z"
}
```

Trigger types: `launch`, `auto`, `queue`. Triggers are processed and deleted on `session_start`.

### Real-Time Web Dashboard

Start a lightweight HTTP API server to monitor harness status programmatically.

```
# Start with dashboard
/harness:launch --dashboard

# Endpoints:
GET /status   — Manager status + worker overview
GET /workers  — Detailed worker state
GET /queue    — Queue contents
GET /memory   — Memory store
GET /logs/<n> — Recent tmux output for a worker
```

Default port: 3847. Dashboard stops automatically with `/harness:stop`. The `--dashboard` flag works on both `/harness:launch` and `/harness:bmad`.

### Live Config Reload

Adjust `maxWorkers` and `staggerMs` mid-run without restarting. Create or edit `.pi-agent/.harness-config.json`:

```json
{ "maxWorkers": 4, "staggerMs": 3000 }
```

The harness checks this file on every `turn_end` cycle (mtime-based). Changes are applied immediately and logged. CLI flags set initial values; the file overrides them at runtime.

| Setting | Range | Default | Notes |
|---------|-------|---------|-------|
| `maxWorkers` | 1–50 | ∞ (no limit) | Applied on next queue dispatch |
| `staggerMs` | 0–60000 | 5000 | Applied on next worker spawn |

Model routes (`.model-routes.json`) and heartbeat config (`.heartbeat-config.json`) changes are also detected and logged, but those files are already re-read per use.

Use `/harness:config` to view current effective values, their sources, and model route status.

## New State Files

| File | Purpose |
|------|---------|
| `.pi-agent/.harness-config.json` | Live-reloadable runtime config (maxWorkers, staggerMs) |
| `.pi-agent/.model-routes.json` | Multi-model routing config |
| `.pi-agent/.memory.json` | Persistent memory store |
| `.pi-agent/.heartbeat-config.json` | Manager heartbeat timing |
| `.pi-agent/.template-store.json` | Template ratings and overrides |
| `.pi-agent/.schedule.json` | Scheduled autonomous runs |
| `.pi-agent/.sandbox.json` | Docker sandbox config |
| `.pi-agent/.triggers/` | Directory for external trigger files |

## Interactive Discovery

`/harness:discover` scans your repository and starts an interactive conversation to help you create tasks. Instead of manually planning what work to do and running `/harness:add` for each task, discover mode:

1. **Gathers a repo snapshot** — file tree, languages, frameworks, recent commits, existing tasks, TODO counts, test framework
2. **Presents a summary** — shows what it found so you can orient quickly
3. **Interviews you** — asks what you want to accomplish, proposes tasks with roles and goals
4. **Creates tasks** — runs `/harness:add` for each approved task

```
# Full scan
/harness:discover

# Focus on specific areas
/harness:discover --focus tests,quality
/harness:discover --focus security,performance
```

**Focus areas**: tests, quality, features, docs, security, performance

This is the recommended starting point when you're unsure what to work on. After discovery creates your tasks, run `/harness:launch` to start workers.

## Tips

- **Start small**: Launch 2-3 workers first to understand the flow
- **Use roles**: Matching the right role to the task improves output quality
- **Check the dashboard**: `/harness:dashboard` shows the full picture
- **Read the inbox**: Workers will send questions and status updates via mailbox
- **Dependencies are powerful**: Use `depends_on` to enforce ordering without manual coordination
- **Cleanup when done**: `/harness:cleanup` removes all worktrees and branches
