import { setLogStreams } from '../../lib/log.js';
import type { ShellRunner } from '../../lib/shell.js';
import { attach } from './attach.js';
import { list } from './list.js';
import { rm } from './rm.js';
import { stop } from './stop.js';
import { up } from './up.js';
import { url } from './url.js';
import type { LauncherContext } from './context.js';
import type {
  DevboxProvider,
  DisplayCredentialsResult,
  ProviderActionResult,
  ProviderBranchRequest,
  ProviderListRequest,
  ProviderUrlRequest,
} from '../types.js';

function launcherContext(
  request: ProviderBranchRequest | ProviderListRequest,
  runner: ShellRunner,
): LauncherContext {
  setLogStreams({ stderr: request.stderr });
  return {
    repoRoot: request.repoRoot,
    repoName: request.repoName,
    runner,
    env: request.env,
    ...(request.envPath === undefined ? {} : { envPath: request.envPath }),
    ...(request.runtimeEnvironment === undefined ? {} : { runtimeEnvironment: request.runtimeEnvironment }),
    tty: request.tty,
    stdin: request.stdin,
    stdout: request.stdout,
    stderr: request.stderr,
  };
}

function action(exitCode: number): ProviderActionResult {
  return { exitCode };
}

/** Adapt the existing Docker/devcontainer lifecycle to the provider contract. */
export function createLocalProvider(runner: ShellRunner): DevboxProvider {
  return {
    name: 'local',
    async up(request: ProviderBranchRequest): Promise<ProviderActionResult> {
      return action(await up(launcherContext(request, runner), request.branch));
    },
    async attach(request: ProviderBranchRequest): Promise<ProviderActionResult> {
      return action(await attach(launcherContext(request, runner), request.branch));
    },
    async stop(request: ProviderBranchRequest): Promise<ProviderActionResult> {
      return action(await stop(launcherContext(request, runner), request.branch));
    },
    async remove(request: ProviderBranchRequest): Promise<ProviderActionResult> {
      return action(await rm(launcherContext(request, runner), request.branch));
    },
    async list(request: ProviderListRequest): Promise<ProviderActionResult> {
      return action(await list(launcherContext(request, runner)));
    },
    async url(request: ProviderUrlRequest): Promise<ProviderActionResult> {
      return action(await url(launcherContext(request, runner), request.branch, request.open));
    },
    async getDisplayCredentials(): Promise<DisplayCredentialsResult> {
      return {
        supported: false,
        message: 'display credentials unsupported by the local provider',
      };
    },
  };
}
