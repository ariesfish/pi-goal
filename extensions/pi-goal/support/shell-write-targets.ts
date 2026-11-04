const DEV_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "&1", "&2"]);

/**
 * Best-effort target extraction for shell writes. It covers redirection,
 * tee, in-place sed/perl, copy/move, dd of=, and truncate. Arbitrary
 * interpreters (python -c, node -e, compiled helpers) remain a residual
 * bypass; the guard is a speed bump, not a sandbox.
 */
export function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim().replace(/^['"]|['"]$/g, "").replace(/^\.\//, "");
    if (!trimmed || trimmed.startsWith("-") || DEV_SINKS.has(trimmed) || /^s[/|#]/.test(trimmed)) return;
    if (!targets.includes(trimmed)) targets.push(trimmed);
  };

  for (const match of command.matchAll(/(?:^|[^0-9&])(?:>>?|1>>?|2>>?|&>)\s*([^\s;&|<>()]+)/g)) {
    add(match[1]);
  }

  for (const match of command.matchAll(/\btee\b((?:\s+-{1,2}[\w-]+)*)\s+([^;&|]+)/g)) {
    for (const token of match[2].split(/\s+/)) add(token);
  }

  for (const match of command.matchAll(/\b(?:sed|perl)\b([^;&|]*)/g)) {
    if (!/\s-[a-zA-Z]*i/.test(match[1]) && !/\s--in-place\b/.test(match[1])) continue;
    for (const token of match[1].split(/\s+/)) {
      if (token.startsWith("-") || token === "") continue;
      add(token);
    }
  }

  for (const match of command.matchAll(/\b(?:cp|mv|install)\b([^;&|]*)/g)) {
    const tokens = match[1].split(/\s+/).filter((token) => token && !token.startsWith("-"));
    if (tokens.length >= 2) add(tokens[tokens.length - 1]);
  }

  for (const match of command.matchAll(/\bdd\b[^;&|]*\bof=([^\s;&|]+)/g)) {
    add(match[1]);
  }

  for (const match of command.matchAll(/\btruncate\b([^;&|]*)/g)) {
    const tokens = match[1].split(/\s+/).filter((token) => token && !token.startsWith("-"));
    if (tokens.length >= 2) add(tokens[tokens.length - 1]);
  }

  return targets;
}
