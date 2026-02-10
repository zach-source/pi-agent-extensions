# Pi Agent Extensions

Extensions for the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

## Extensions

- **graphiti.ts** - Graphiti temporal knowledge graph integration (search, add memories, status)
- **heartbeat.ts** - Periodic task runner that reads `heartbeat.md` and wakes the agent to work through tasks

## Usage

These files are deployed to `~/.pi/agent/extensions/` via [nix-darwin/home-manager](https://github.com/zach-source/dotfiles) as a flake input.
