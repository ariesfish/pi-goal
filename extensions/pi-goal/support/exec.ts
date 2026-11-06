/**
 * The host's process runner.
 *
 * The gate, the reviewer, the workspace checks, the experiment runner, and the
 * validation dry run all take the same thing: an object with an `exec` method
 * shaped like the extension host's. Declaring that shape once keeps the six
 * copies from drifting, and gives tests a single interface to fake.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Present when the host killed the process for its timeout or signal. */
  killed?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HostExec {
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}
