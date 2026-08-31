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
    const client = {
      runCommand: async (_sandbox: VercelSandboxHandle, request: { cmd?: string; args?: readonly string[]; signal?: AbortSignal }) => {
        commands.push(request);
        return { exitCode: 0 };
      },
    } as unknown as VercelSandboxClient;
    const sandbox = {
      currentSession: () => ({ sessionId: 'session-1' }),
    } as unknown as VercelSandboxHandle;

    const shell = await prepareVercelTerminalShell({
      sandbox,
      client,
      cwd: '/vercel/sandbox/repo',
    });

    expect(shell.socketDirectory).toMatch(
      new RegExp(`^${DEVBOX_TMUX_SOCKET_ROOT}/${DEVBOX_TMUX_SOCKET_DIRECTORY_PREFIX}`),
    );
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
    expect(VERCEL_TERMINAL_SHELL_SETUP_TIMEOUT_MS).toBe(30_000);
  });

  it('keeps one socket directory for a session and separates another session', async () => {
    const client = {
      runCommand: async () => ({ exitCode: 0 }),
    } as unknown as VercelSandboxClient;
    const firstSandbox = {
      id: 'sandbox-id-that-must-not-be-used',
      currentSession: () => ({ sessionId: 'same-session' }),
    } as unknown as VercelSandboxHandle;
    const secondSandbox = {
      currentSession: () => ({ sessionId: 'new-session' }),
    } as unknown as VercelSandboxHandle;

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
    let sessionReads = 0;
    const client = {
      runCommand: async (_sandbox: VercelSandboxHandle, request: { args?: readonly string[] }) => {
        commands.push(request);
        return { exitCode: 0 };
      },
    } as unknown as VercelSandboxClient;
    const sandbox = {
      currentSession: () => ({ sessionId: sessionReads++ === 0 ? 'session-before-resume' : 'session-after-resume' }),
    } as unknown as VercelSandboxHandle;

    const shell = await prepareVercelTerminalShell({
      sandbox,
      client,
      cwd: '/repo',
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]?.args?.[1]).toContain('c2Vzc2lvbi1iZWZvcmUtcmVzdW1l');
    expect(commands[1]?.args?.[1]).toContain('c2Vzc2lvbi1hZnRlci1yZXN1bWU');
    expect(shell.socketDirectory).toContain('c2Vzc2lvbi1hZnRlci1yZXN1bWU');
    expect(shell.program.args).toContain(`${shell.socketDirectory}/socket`);
  });

  it('fails before terminal attach when the provider session identity is missing', async () => {
    const client = {
      runCommand: async () => ({ exitCode: 0 }),
    } as unknown as VercelSandboxClient;
    const sandbox = {
      currentSession: () => ({}),
    } as unknown as VercelSandboxHandle;

    await expect(prepareVercelTerminalShell({ sandbox, client, cwd: '/repo' }))
      .rejects.toThrow('Vercel current session ID is unavailable');
  });
});
