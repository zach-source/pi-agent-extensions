# Harness: Multi-Agent Orchestration for Pi

The Harness extension turns a single Pi session into a parallel workforce. It uses **git worktrees** for isolation, **tmux sessions** for concurrent execution, and a dedicated **manager agent** to monitor progress, auto-merge completed work, and dispatch queued tasks.

## Quick Start

```
# 1. Initialize the harness directory structure
/harness:init

# 2. Add tasks with goals
/harness:add auth-api Implement JWT auth, Add refresh token endpoint, Write integration tests
/harness:add data-layer Set up Prisma schema, Write repository layer, Add seed script

# 3. Launch workers + manager
/harness:launch
```

That's it. Each task gets its own git worktree and tmux session. A manager agent monitors progress, auto-merges completed branches, and dispatches queued work.

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
| `/harness:launch` | Create worktrees, spawn workers + manager |
| `/harness:auto [objective]` | Autonomous: scout → plan → execute → re-scout loop |
| `/harness:stop` | Gracefully stop all workers and the manager |
| `/harness:cleanup` | Remove all worktrees, branches, and state files |

### Task Management

| Command | Description |
|---------|-------------|
| `/harness:add <name> [goals...]` | Create a task with comma-separated goals |
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

### Prerequisites

Initialize BMAD in your project first:
```
/bmad-init
```

This creates `bmad/config.yaml` and `docs/bmm-workflow-status.yaml`.

### Running BMAD via Harness

```
/harness:bmad --max-workers 3
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

## Tips

- **Start small**: Launch 2-3 workers first to understand the flow
- **Use roles**: Matching the right role to the task improves output quality
- **Check the dashboard**: `/harness:dashboard` shows the full picture
- **Read the inbox**: Workers will send questions and status updates via mailbox
- **Dependencies are powerful**: Use `depends_on` to enforce ordering without manual coordination
- **Cleanup when done**: `/harness:cleanup` removes all worktrees and branches
