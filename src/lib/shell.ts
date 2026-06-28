/**
 * Shell execution abstraction.
 *
 * Provides injectable exec helpers so commands can be unit-tested without
 * spawning real git/docker processes. The real implementation uses
 * child_process; tests inject a mock.
 */
import { spawn } from 'node:child_process';

export interface ShellRunner {
  /** Run a command, return stdout (trimmed). Throws on non-zero exit. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<string>;

  /** Run a command and return { stdout, code }. Does not throw on non-zero. */
  execQuiet(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  /** Spawn a command with inherited stdio, forward signals, return exit code. */
  spawnInherit(command: string, args: string[], options?: ExecOptions): Promise<number>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  /** If true, suppress stderr output (pipe to /dev/null). */
  silentStderr?: boolean;
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
        stdio: ['pipe', 'pipe', options?.silentStderr ? 'ignore' : 'inherit'],
      });
      let stdout = '';
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      if (options?.stdin && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
      child.on('close', (code) => {
        resolve({ stdout, code: code ?? 0 });
      });
    });
  }

  /**
   * Spawn a child process with inherited stdio. Forwards SIGINT/SIGTERM from
   * the parent to the child. Resolves with the child's exit code.
   *
   * This replaces bash's `exec` — Node has no exec(2), so we spawn and wait,
   * making the child the effective foreground process.
   */
  spawnInherit(command: string, args: string[], options?: ExecOptions): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env as Record<string, string> | undefined,
        stdio: 'inherit',
      });

      // Forward signals to the child so Ctrl-C etc. reach it, not just us.
      const onSignal = (signal: NodeJS.Signals) => {
        child.kill(signal);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);

      child.on('close', (code) => {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolve(code ?? 0);
      });
    });
  }
}

/** Singleton real runner. */
export const shell: ShellRunner = new RealShellRunner();

/**
 * Check if a command is available on the system (like bash's `command -v`).
 */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const { execQuiet } = new RealShellRunner();
    const result = await execQuiet('which', [cmd], { silentStderr: true });
    return result.code === 0;
  } catch {
    return false;
  }
}
