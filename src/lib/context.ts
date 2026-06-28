/**
 * Shared context for launcher commands.
 *
 * Each command receives a LauncherContext with the repo info, shell runner,
 * and environment. Commands are thin: they call lib/ functions and format
 * output.
 */
import type { ShellRunner } from './shell.js';

export interface LauncherContext {
  repoRoot: string;
  repoName: string;
  runner: ShellRunner;
  env: Record<string, string | undefined>;
  /** Whether stdin is a TTY (for docker exec -i vs -it). */
  tty: boolean;
}
