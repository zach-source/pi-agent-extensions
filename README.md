# Pi Agent Extensions

Extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

### Core

- **bmad.ts** - BMAD Method (Breakthrough Method for Agile AI-Driven Development) with 4 phases, 13 workflow commands, and 4 LLM-callable tools
- **graphiti.ts** - Graphiti temporal knowledge graph integration (search, add memories, status)
- **heartbeat.ts** - Periodic task runner that reads `heartbeat.md` and wakes the agent to work through tasks

### Workflow

- **plan-mode.ts** - Read-only plan mode with tool blocking, numbered step extraction, and progress tracking
- **todo.ts** - File-based todo list with `/todos` command and `todo` tool for the LLM
- **designer.ts** - UI/UX design agent with anti-slop patterns and structured review prompts
- **reviewer.ts** - Structured code review with P0-P3 findings, confidence scores, and verdict system

### Git & Safety

- **git-checkpoint.ts** - Automatic git stash checkpoints on each turn with restore capability
- **auto-commit-on-exit.ts** - Auto-commit dirty working tree on session shutdown
- **permission-gate.ts** - Block destructive bash commands with pattern matching and safe overrides

### System

- **mcp-server.ts** - General-purpose MCP client that connects to any MCP server (stdio/HTTP), discovers tools, and registers them as Pi tools. Supports both `.mcp.json` (Claude format) and `.pi/mcp.json` configs
- **tools-manager.ts** - Enable/disable tools via config file with `tool_call` event blocking
- **custom-compaction.ts** - Preserve context across compactions with Graphiti integration
- **reload-runtime.ts** - Hot-reload Pi extensions without restarting the session

## Usage

These files are deployed to `~/.pi/agent/extensions/` via [nix-darwin/home-manager](https://github.com/zach-source/dotfiles) as a flake input.
