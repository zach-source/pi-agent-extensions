# Pi Agent Extensions

Extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

- **bmad.ts** - BMAD Method (Breakthrough Method for Agile AI-Driven Development) with 4 phases, 13 workflow commands, and 4 LLM-callable tools
- **graphiti.ts** - Graphiti temporal knowledge graph integration (search, add memories, status)
- **heartbeat.ts** - Periodic task runner that reads `heartbeat.md` and wakes the agent to work through tasks

## Usage

These files are deployed to `~/.pi/agent/extensions/` via [nix-darwin/home-manager](https://github.com/zach-source/dotfiles) as a flake input.
