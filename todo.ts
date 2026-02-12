/**
 * Todo Extension for Pi
 *
 * LLM-callable todo tool with file-based persistence. The agent can
 * manage a todo list (add, toggle, clear) and users can view it
 * with the /todos command.
 *
 * State is stored in .pi-todos.json in the project root.
 *
 * Tools:
 *   todo  - Manage todo list (list, add, toggle, clear)
 *
 * Commands:
 *   /todos  - Show current todos
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

// Local StringEnum helper
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: Record<string, unknown>,
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// --- Types ---

export interface Todo {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
}

interface TodoState {
  todos: Todo[];
  nextId: number;
}

// --- State management ---

const TODO_FILE = ".pi-todos.json";

let state: TodoState = { todos: [], nextId: 1 };
let currentCwd = "";

async function loadState(cwd: string): Promise<void> {
  currentCwd = cwd;
  try {
    const content = await readFile(join(cwd, TODO_FILE), "utf-8");
    const parsed = JSON.parse(content) as TodoState;
    state = {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      nextId: typeof parsed.nextId === "number" ? parsed.nextId : 1,
    };
  } catch {
    state = { todos: [], nextId: 1 };
  }
}

async function saveState(): Promise<void> {
  if (!currentCwd) return;
  await writeFile(
    join(currentCwd, TODO_FILE),
    JSON.stringify(state, null, 2) + "\n",
  );
}

function formatTodoList(todos: Todo[]): string {
  if (todos.length === 0) return "No todos.";

  const done = todos.filter((t) => t.done).length;
  const lines = [`${done}/${todos.length} completed`, ""];

  for (const todo of todos) {
    const check = todo.done ? "[x]" : "[ ]";
    lines.push(`${check} #${todo.id}: ${todo.text}`);
  }

  return lines.join("\n");
}

// --- Tool parameters ---

const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const, {
    description: "Action to perform on the todo list",
  }),
  text: Type.Optional(
    Type.String({ description: "Todo text (required for 'add')" }),
  ),
  id: Type.Optional(
    Type.Number({ description: "Todo ID (required for 'toggle')" }),
  ),
});

// --- Extension ---

export default function (pi: ExtensionAPI) {
  // Load state on session start
  pi.on("session_start", async (_event, ctx) => {
    await loadState(ctx.cwd);

    const pending = state.todos.filter((t) => !t.done).length;
    if (pending > 0) {
      ctx.ui.setStatus("todos", `todos: ${pending} pending`);
    }
  });

  // --- todo tool ---
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a todo list. Actions: " +
      "'list' (show all todos), " +
      "'add' (add with text param), " +
      "'toggle' (toggle done with id param), " +
      "'clear' (remove all).",
    parameters: TodoParams,

    async execute(_toolCallId, params) {
      const { action, text, id } = params as {
        action: string;
        text?: string;
        id?: number;
      };

      switch (action) {
        case "list":
          return {
            content: [{ type: "text", text: formatTodoList(state.todos) }],
            details: { action: "list", count: state.todos.length },
          };

        case "add": {
          if (!text) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'text' parameter required for add action.",
                },
              ],
              details: {},
            };
          }
          const newTodo: Todo = {
            id: state.nextId++,
            text,
            done: false,
            createdAt: new Date().toISOString(),
          };
          state.todos.push(newTodo);
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Added todo #${newTodo.id}: ${newTodo.text}`,
              },
            ],
            details: {
              action: "add",
              id: newTodo.id,
              text: newTodo.text,
            },
          };
        }

        case "toggle": {
          if (id === undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: 'id' parameter required for toggle action.",
                },
              ],
              details: {},
            };
          }
          const todo = state.todos.find((t) => t.id === id);
          if (!todo) {
            return {
              content: [
                {
                  type: "text",
                  text: `Todo #${id} not found.`,
                },
              ],
              details: {},
            };
          }
          todo.done = !todo.done;
          await saveState();
          return {
            content: [
              {
                type: "text",
                text: `Todo #${todo.id} ${todo.done ? "completed" : "reopened"}: ${todo.text}`,
              },
            ],
            details: {
              action: "toggle",
              id: todo.id,
              done: todo.done,
            },
          };
        }

        case "clear": {
          const count = state.todos.length;
          state.todos = [];
          state.nextId = 1;
          await saveState();
          return {
            content: [{ type: "text", text: `Cleared ${count} todos.` }],
            details: { action: "clear", cleared: count },
          };
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown action: ${action}. Use: list, add, toggle, clear.`,
              },
            ],
            details: {},
          };
      }
    },
  });

  // --- /todos command ---
  pi.registerCommand("todos", {
    description: "Show current todo list",
    handler: async (_args, ctx) => {
      await loadState(ctx.cwd);

      if (state.todos.length === 0) {
        ctx.ui.notify("No todos. Ask the agent to add some!", "info");
        return;
      }

      pi.sendMessage(
        {
          customType: "todos",
          content: `## Todos\n\n${formatTodoList(state.todos)}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
