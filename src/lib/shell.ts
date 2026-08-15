/**
 * Shell execution abstraction.
 *
 * Provides injectable exec helpers so commands can be unit-tested without
 * spawning real git/docker processes. The real implementation uses
 * child_process; tests inject a mock.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

export interface ShellRunner {
  /** Run a command, return stdout (trimmed). Throws on non-zero exit. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<string>;

  /** Run a command and return { stdout, code }. Does not throw on non-zero. */
  execQuiet(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  /** Spawn a command with inherited stdio, forward signals, return exit code.
   *  signalSource defaults to `process`; inject a fake for testing. */
  spawnInherit(
    command: string,
    args: string[],
    options?: ExecOptions,
    signalSource?: EventEmitter,
  ): Promise<number>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** If true, suppress stderr output (pipe to /dev/null). */
  silentStderr?: boolean;
  /** Route child stderr to a caller-owned stream instead of process.stderr. */
  stderr?: Writable;
  /** If set, stream stdout chunks to this stream (e.g. process.stderr) with
   *  the given prefix, while also capturing into the returned stdout string.
   *  Used for devcontainer up so the user sees build progress live. */
  streamStdoutTo?: { stream: Writable; prefix: string };
}

export interface ExecResult {
  stdout: string;
  code: number;
}

/** Real ShellRunner using child_process. */
export class RealShellRunner implements ShellRunner {
  async exec(command: string, args: string[], options?: ExecOptions): Promise<string> {
    const result = await this.execQuiet(command, args, options);
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(' ')} exited with code ${result.code}`);
    }
    return result.stdout.trim();
  }

  async execQuiet(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env as Record<string, string> | undefined,
        stdio: ['pipe', 'pipe', options?.silentStderr ? 'ignore' : options?.stderr ? 'pipe' : 'inherit'],
      });
      let stdout = '';
      let settled = false;
      const finish = (result: ExecResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (options?.streamStdoutTo) {
          const { stream, prefix } = options.streamStdoutTo;
          // Write each line with the prefix, matching bash's sed prefix.
          for (const line of data.toString().split('\n')) {
            if (line.length > 0) stream.write(`${prefix}${line}\n`);
          }
        }
      });
      if (options?.stderr) {
        child.stderr?.on('data', (data: Buffer) => {
          options.stderr?.write(data);
        });
      }
      if (options?.stdin && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
      child.on('error', () => {
        // Match shell command-not-found behavior while keeping execQuiet's
        // non-throwing contract and the provider error boundary intact.
        finish({ stdout, code: 127 });
      });
      child.on('close', (code) => {
        finish({ stdout, code: code ?? 0 });
      });
    });
  }

  /**
   * Spawn a child process with inherited stdio. Forwards SIGINT/SIGTERM from
   * the parent to the child. Resolves with the child's exit code.
   *
   * This replaces bash's `exec` — Node has no exec(2), so we spawn and wait,
   * making the child the effective foreground process.
   *
   * signalSource defaults to `process`; tests inject a fake EventEmitter so
   * they can emit signals without killing the vitest process.
   */
  spawnInherit(
    command: string,
    args: string[],
    options?: ExecOptions,
    signalSource: EventEmitter = process as unknown as EventEmitter,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env as Record<string, string> | undefined,
        stdio: 'inherit',
      });

      // Handle spawn errors (ENOENT, EACCES, etc.) - without this,
      // the promise would hang forever if the command doesn't exist.
      child.on('error', (err) => {
        signalSource.off('SIGINT', onSignal);
        signalSource.off('SIGTERM', onSignal);
        reject(err);
      });

      // Forward signals to the child so Ctrl-C etc. reach it, not just us.
      const onSignal = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      signalSource.on('SIGINT', onSignal);
      signalSource.on('SIGTERM', onSignal);

      child.on('close', (code) => {
        signalSource.off('SIGINT', onSignal);
        signalSource.off('SIGTERM', onSignal);
        resolve(code ?? 0);
      });
    });
  }
}

/** Singleton real runner. */
export const shell: ShellRunner = new RealShellRunner();

/**
 * Safely single-quote-escape a string for use inside a shell single-quoted
 * context. Replaces each `'` with `'{\}'` (close quote, escaped quote,
 * reopen quote), then wraps the whole thing in single quotes.
 *
 * Equivalent to bash's `printf '%q'` for the single-quote-in-single-quotes
 * case. Used for writing GH_TOKEN into /etc/profile.d/gh-token.sh.
 */
export function escapeShellSingleQuote(value: string): string {
  // To embed a single quote inside a single-quoted shell string, close the
  // quote, add an escaped quote (\'), then reopen: ' -> '\''
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Check if a command is available through a supplied shell runner.
 * Providers use this seam so prerequisite failures remain testable without
 * spawning host commands.
 */
export async function commandExistsWithRunner(runner: ShellRunner, cmd: string): Promise<boolean> {
  const result = await runner.execQuiet('which', [cmd], { silentStderr: true });
  return result.code === 0;
}

/** Check if a command is available on the host. */
export async function commandExists(cmd: string): Promise<boolean> {
  return commandExistsWithRunner(new RealShellRunner(), cmd);
}
