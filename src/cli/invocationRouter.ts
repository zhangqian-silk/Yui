import { findChild, ROOT_COMMAND, type CommandNode } from "./commandCatalog.js";

export type Invocation =
  | { kind: "execute"; node: CommandNode }
  | { kind: "help"; node: CommandNode }
  | { kind: "path-error"; typedPath: string; helpNode: CommandNode }
  | { kind: "incomplete"; typedPath: string; helpNode: CommandNode };

export function routeInvocation(args: readonly string[]): Invocation {
  if (args.length === 0) {
    return { kind: "execute", node: ROOT_COMMAND };
  }

  if (args[0] === "help") {
    return resolveHelpPath(args.slice(1));
  }

  return resolveExecutionPath(args);
}

function resolveHelpPath(path: readonly string[]): Invocation {
  if (path.length === 0) {
    return { kind: "help", node: ROOT_COMMAND };
  }

  let node = ROOT_COMMAND;
  let nearestGroup = ROOT_COMMAND;
  for (let index = 0; index < path.length; index += 1) {
    const child = findChild(node, path[index] ?? "");
    if (child === undefined) {
      return { kind: "path-error", typedPath: path.join(" "), helpNode: nearestGroup };
    }
    node = child;
    if (node.kind !== "leaf") {
      nearestGroup = node;
    }
  }
  return { kind: "help", node };
}

function resolveExecutionPath(args: readonly string[]): Invocation {
  let node = ROOT_COMMAND;
  let nearestGroup = ROOT_COMMAND;
  let index = 0;

  while (index < args.length) {
    if (node.kind === "leaf") {
      break;
    }

    const token = args[index] ?? "";
    const child = findChild(node, token);
    if (child === undefined) {
      if (node.kind === "hybrid") {
        break;
      }
      return {
        kind: "path-error",
        typedPath: args.slice(0, index + 1).join(" "),
        helpNode: nearestGroup
      };
    }

    node = child;
    index += 1;
    if (node.kind !== "leaf") {
      nearestGroup = node;
    }
  }

  if (node.kind === "group" && index === args.length) {
    return { kind: "incomplete", typedPath: args.join(" "), helpNode: node };
  }
  return { kind: "execute", node };
}
