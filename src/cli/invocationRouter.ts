import { findChild, ROOT_COMMAND, type CommandNode } from "./commandCatalog.js";

export type Invocation =
  | Readonly<{ kind: "execute"; node: CommandNode }>
  | Readonly<{ kind: "help"; node: CommandNode }>
  | Readonly<{ kind: "path-error"; typedPath: string; helpNode: CommandNode }>
  | Readonly<{ kind: "incomplete"; typedPath: string; helpNode: CommandNode }>;

export function routeInvocation(args: readonly string[]): Invocation {
  if (args.length === 0) return { kind: "execute", node: ROOT_COMMAND };
  if (args[0] === "help") return resolveHelpPath(args.slice(1));
  return resolveExecutionPath(args);
}

function resolveHelpPath(path: readonly string[]): Invocation {
  if (path.length === 0) return { kind: "help", node: ROOT_COMMAND };
  let node = ROOT_COMMAND;
  let nearestGroup = ROOT_COMMAND;
  for (const segment of path) {
    const child = findChild(node, segment);
    if (child === undefined || child.hidden) {
      return { kind: "path-error", typedPath: path.join(" "), helpNode: nearestGroup };
    }
    node = child;
    if (node.kind !== "leaf") nearestGroup = node;
  }
  return { kind: "help", node };
}

function resolveExecutionPath(args: readonly string[]): Invocation {
  let node = ROOT_COMMAND;
  let nearestGroup = ROOT_COMMAND;
  let index = 0;
  while (index < args.length) {
    if (node.kind === "leaf") break;
    const child = findChild(node, args[index] ?? "");
    const internalExecutable = child !== undefined && (
      (node === ROOT_COMMAND && child.name === "internal")
      || (node.path.join(" ") === "yui config completion" && child.name === "candidates")
      || (node.path.join(" ") === "yui task run"
        && (child.name === "checkpoint" || child.name === "context"))
      || (node.path.join(" ") === "yui controller"
        && (child.name === "identity" || child.name === "live-identity"))
    );
    if (child === undefined || (child.hidden && !internalExecutable)) {
      if (node.kind === "hybrid" && node.acceptsArguments) break;
      return {
        kind: "path-error",
        typedPath: args.slice(0, index + 1).join(" "),
        helpNode: nearestGroup
      };
    }
    node = child;
    index += 1;
    if (node.kind !== "leaf") nearestGroup = node;
  }
  if (node.kind === "group" && index === args.length) {
    return { kind: "incomplete", typedPath: args.join(" "), helpNode: node };
  }
  return { kind: "execute", node };
}
