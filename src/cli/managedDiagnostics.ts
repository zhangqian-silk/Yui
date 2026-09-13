/** Read/repair routing, not an alternative grant. Callers still prove their
 * Home and Role identity; writes still require current Session authority. */
export function taskDiagnosticTarget(args: readonly string[]): string | undefined {
  if (args[0] !== "task") return undefined;
  if (["show", "context", "next-action", "archive-preflight"].includes(args[1] ?? "")) {
    return args[1] === "context" && ["inspect", "delta"].includes(args[2] ?? "")
      ? args[3] : args[2];
  }
  if (args[1] === "role" && ["list", "status", "show"].includes(args[2] ?? "")) return args[3];
  if (args[1] === "role" && args[2] === "session" && args[3] === "inspect") return args[4];
  if (["message", "run", "wake", "input"].includes(args[1] ?? "")
    && ["list", "show"].includes(args[2] ?? "")) return args[3]?.split("/")[0];
  return undefined;
}

export function operatorOfflineCommand(args: readonly string[]): boolean {
  return (args[0] === "controller"
      && ["status", "identity", "live-identity", "stop", "restart"].includes(args[1] ?? ""))
    || args[0] === "doctor"
    || (args[0] === "execution" && args[1] === "audit")
    || (args[0] === "operator" && ["status", "list"].includes(args[1] ?? ""))
    || (args[0] === "session" && ["context", "reconcile"].includes(args[1] ?? ""))
    || (args[0] === "task" && args[1] === "list")
    || taskDiagnosticTarget(args) !== undefined;
}
