/**
 * Container lookup and URL computation.
 *
 * Containers are tagged with `devbox.branch=<branch>` and
 * `devbox.repo=<repoName>` labels at creation time. These functions query
 * by label — the source of truth, not CLI text parsing.
 *
 * OrbStack exposes container ports at `<name>.orb.local:<port>`. The bash
 * version only uses .orb.local (no real IP fallback despite a comment about
 * it); we match that. A non-OrbStack fallback is a future improvement.
 */
import type { ShellRunner } from './shell.js';

/**
 * Format the id-label used to tag containers for a branch.
 */
export function idLabel(branch: string): string {
  return `devbox.branch=${branch}`;
}

/**
 * Find the running container id for a branch.
 * Returns empty string if none found.
 */
export async function containerFor(runner: ShellRunner, branch: string): Promise<string> {
  const result = await runner.execQuiet('docker', ['ps', '-q', '--filter', `label=${idLabel(branch)}`], {});
  return result.stdout.trim();
}

/**
 * Find any container (running or stopped) for a branch.
 * Returns empty string if none found.
 */
export async function containerForAll(runner: ShellRunner, branch: string): Promise<string> {
  const result = await runner.execQuiet('docker', ['ps', '-aq', '--filter', `label=${idLabel(branch)}`], {});
  return result.stdout.trim();
}

/**
 * Compute the noVNC URL for a container.
 * Uses the container name from `docker inspect`, formatted as
 * `http://<name>.orb.local:6080/vnc.html`.
 */
export async function novncUrlFor(runner: ShellRunner, cid: string): Promise<string> {
  const name = await runner.exec('docker', ['inspect', cid, '--format', '{{.Name}}'], {});
  // Container names from docker inspect have a leading slash.
  const cleanName = name.replace(/^\//, '');
  return `http://${cleanName}.orb.local:6080/vnc.html`;
}

/**
 * Get the container name for a cid.
 */
export async function containerName(runner: ShellRunner, cid: string): Promise<string> {
  const name = await runner.exec('docker', ['inspect', cid, '--format', '{{.Name}}'], {});
  return name.replace(/^\//, '');
}
