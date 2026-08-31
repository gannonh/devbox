import { describe, expect, it } from 'vitest';
import type { VercelSandboxClient, VercelSandboxHandle } from '../src/providers/vercel/client.js';
import {
  DEVBOX_TMUX_SESSION_NAME,
  DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX,
  DEVBOX_TMUX_SOCKET_ROOT,
  VERCEL_TERMINAL_SHELL_SETUP_TIMEOUT_MS,
  prepareVercelTerminalShell,
} from '../src/providers/vercel/terminal-shell.js';

describe('Vercel terminal shell', () => {
  it('reconciles other devbox sockets and returns a session-derived tmux program', async () => {
    const commands: Array<{ cmd?: string; args?: readonly string[]; signal?: AbortSignal }> = [];
    const strictSessionIds: string[] = [];
    const runCommand = async (request: { cmd?: string; args?: readonly string[]; signal?: AbortSignal }) => {
      commands.push(request);
      return { exitCode: 0 };
    };
    const sandbox = {
      currentSession: () => ({ sessionId: 'session-1', runCommand }),
    } as unknown as VercelSandboxHandle;
    const client = {
      runCommand: async (
        _sandbox: VercelSandboxHandle,
        request: { cmd?: string; args?: readonly string[]; signal?: AbortSignal },
        options?: { expectedSessionId: string },
      ) => {
        if (options !== undefined) strictSessionIds.push(options.expectedSessionId);
        return runCommand(request);
      },
    } as unknown as VercelSandboxClient;

    const shell = await prepareVercelTerminalShell({
      sandbox,
      client,
      cwd: '/vercel/sandbox/repo',
    });

    expect(shell.socketDirectory).toMatch(
      new RegExp(`^${DEVBOX_TMUX_SOCKET_ROOT}/${DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX}`),
    );
    expect(shell.sessionId).toBe('session-1');
    expect(shell.program).toEqual({
      command: 'tmux',
      args: [
        '-S',
        `${shell.socketDirectory}/socket`,
        'new-session',
        '-A',
        '-s',
        DEVBOX_TMUX_SESSION_NAME,
        '-c',
        '/vercel/sandbox/repo',
      ],
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(commands[0]?.cmd).toBe('sh');
    expect(commands[0]?.args?.[0]).toBe('-c');
    expect(commands[0]?.args?.[1]).toContain('tmux');
    expect(commands[0]?.args?.[1]).toContain(`${DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX}`);
    expect(commands[0]?.args?.[1]).toContain('"$root"/');
    expect(commands[0]?.args?.[1]).not.toContain('"$root"/*;');
    expect(strictSessionIds).toEqual(['session-1']);
    expect(VERCEL_TERMINAL_SHELL_SETUP_TIMEOUT_MS).toBe(30_000);
  });

  it('keeps one socket directory for a session and separates another session', async () => {
    const runCommand = async () => ({ exitCode: 0 });
    const firstSandbox = {
      id: 'sandbox-id-that-must-not-be-used',
      currentSession: () => ({ sessionId: 'same-session', runCommand }),
    } as unknown as VercelSandboxHandle;
    const secondSandbox = {
      currentSession: () => ({ sessionId: 'new-session', runCommand }),
    } as unknown as VercelSandboxHandle;
    const client = { runCommand: async () => ({ exitCode: 0 }) } as unknown as VercelSandboxClient;

    const first = await prepareVercelTerminalShell({
      sandbox: firstSandbox,
      client,
      cwd: '/repo',
    });
    const same = await prepareVercelTerminalShell({
      sandbox: firstSandbox,
      client,
      cwd: '/repo',
    });
    const second = await prepareVercelTerminalShell({
      sandbox: secondSandbox,
      client,
      cwd: '/repo',
    });

    expect(same.socketDirectory).toBe(first.socketDirectory);
    expect(second.socketDirectory).not.toBe(first.socketDirectory);
    expect(first.socketPath).toBe(`${first.socketDirectory}/socket`);
  });

  it('reconciles again when runCommand resumes the sandbox into a new session', async () => {
    const commands: Array<{ args?: readonly string[] }> = [];
    const strictSessionIds: string[] = [];
    let sessionReads = 0;
    const runCommand = async (request: { args?: readonly string[] }) => {
      commands.push(request);
      return { exitCode: 0 };
    };
    const sandbox = {
      currentSession: () => ({
        sessionId: sessionReads++ < 1 ? 'session-before-resume' : 'session-after-resume',
        runCommand,
      }),
    } as unknown as VercelSandboxHandle;
    const client = {
      runCommand: async (
        _sandbox: VercelSandboxHandle,
        request: { args?: readonly string[] },
        options?: { expectedSessionId: string },
      ) => {
        if (options !== undefined) strictSessionIds.push(options.expectedSessionId);
        return runCommand(request);
      },
    } as unknown as VercelSandboxClient;

    const shell = await prepareVercelTerminalShell({
      sandbox,
      client,
      cwd: '/repo',
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]?.args?.[1]).toContain('c2Vzc2lvbi1iZWZvcmUtcmVzdW1l');
    expect(commands[1]?.args?.[1]).toContain('c2Vzc2lvbi1hZnRlci1yZXN1bWU');
    expect(strictSessionIds).toEqual(['session-before-resume', 'session-after-resume']);
    expect(shell.socketDirectory).toContain('c2Vzc2lvbi1hZnRlci1yZXN1bWU');
    expect(shell.program.args).toContain(`${shell.socketDirectory}/socket`);
  });

  it('fails before terminal attach when the provider session identity is missing', async () => {
    const sandbox = {
      currentSession: () => ({}),
    } as unknown as VercelSandboxHandle;
    const client = { runCommand: async () => ({ exitCode: 0 }) } as unknown as VercelSandboxClient;

    await expect(prepareVercelTerminalShell({ sandbox, client, cwd: '/repo' }))
      .rejects.toThrow('Vercel current session ID is unavailable');
  });
});
