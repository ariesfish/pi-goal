/**
 * The `/goal` grammar, as a pure function.
 *
 * Routing used to be a chain of string comparisons inside the command handler,
 * where it could only be exercised through an ExtensionAPI and a real
 * ExtensionContext. Keeping the table here makes every branch a plain assert.
 */

export type GoalIntent =
  | { kind: "help" }
  | { kind: "off" }
  | { kind: "clear" }
  | { kind: "export" }
  | { kind: "reinit" }
  | { kind: "select-usage" }
  | { kind: "select"; researchId: string }
  | { kind: "allow-tests" }
  | { kind: "protect-tests" }
  | { kind: "allow-benchmark" }
  | { kind: "protect-benchmark" }
  | { kind: "start"; goal: string };

export function parseGoalIntent(args: string | undefined): GoalIntent {
  const raw = (args ?? "").trim();
  const command = raw.toLowerCase();

  if (!raw) return { kind: "help" };

  switch (command) {
    case "off":
      return { kind: "off" };
    case "clear":
      return { kind: "clear" };
    case "export":
      return { kind: "export" };
    case "reinit":
      return { kind: "reinit" };
    case "select":
      return { kind: "select-usage" };
    case "allow-tests":
      return { kind: "allow-tests" };
    case "protect-tests":
      return { kind: "protect-tests" };
    case "allow-benchmark":
      return { kind: "allow-benchmark" };
    case "protect-benchmark":
      return { kind: "protect-benchmark" };
  }

  // `select <id>` keeps the id's original case; the id is sanitized later.
  if (command.startsWith("select ")) {
    return { kind: "select", researchId: raw.slice("select".length).trim() };
  }

  return { kind: "start", goal: raw };
}
