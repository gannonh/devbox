import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmVercelScope,
  resolveVercelCredentials,
  resolveVercelCredentialsForScope,
} from '../src/providers/vercel/auth.js';

describe('Vercel credential resolution', () => {
  it('reuses stored scope with a token-only environment for existing operations', async () => {
    await expect(resolveVercelCredentialsForScope({
      repoRoot: '/repo',
      env: { VERCEL_TOKEN: 'new-vercel-token' },
      scope: { teamId: 'stored-team', projectId: 'stored-project' },
    })).resolves.toEqual({
      token: 'new-vercel-token',
      teamId: 'stored-team',
      projectId: 'stored-project',
    });
  });

  it('uses a complete explicit credential triad without invoking device auth', async () => {
    const deviceAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot: '/repo',
      env: {
        VERCEL_TOKEN: 'token',
        VERCEL_TEAM_ID: 'team',
        VERCEL_PROJECT_ID: 'project',
      },
      deviceAuth,
    })).resolves.toEqual({
      token: 'token',
      teamId: 'team',
      projectId: 'project',
    });

    expect(deviceAuth).not.toHaveBeenCalled();
  });

  it('prefers a complete explicit credential triad over OIDC credentials', async () => {
    const deviceAuth = vi.fn();
    const oidc = `header.${Buffer.from(JSON.stringify({
      owner_id: 'oidc-team',
      project_id: 'oidc-project',
    })).toString('base64url')}.sig`;

    await expect(resolveVercelCredentials({
      repoRoot: '/repo',
      env: {
        VERCEL_TOKEN: 'explicit-token',
        VERCEL_TEAM_ID: 'explicit-team',
        VERCEL_PROJECT_ID: 'explicit-project',
        VERCEL_OIDC_TOKEN: oidc,
      },
      deviceAuth,
    })).resolves.toEqual({
      token: 'explicit-token',
      teamId: 'explicit-team',
      projectId: 'explicit-project',
    });

    expect(deviceAuth).not.toHaveBeenCalled();
  });

  it('rejects OIDC tokens containing characters outside base64url segments', async () => {
    const payload = Buffer.from(JSON.stringify({
      owner_id: 'team',
      project_id: 'project',
    })).toString('base64url');

    for (const invalidCharacter of ['!', '/', '=']) {
      const oidc = `header.${payload}${invalidCharacter}.sig`;
      await expect(resolveVercelCredentials({
        repoRoot: '/repo',
        env: { VERCEL_OIDC_TOKEN: oidc },
      })).rejects.toThrow(/invalid.*OIDC.*character|segment/i);
    }
  });

  it('rejects a partial explicit credential triad before device auth', async () => {
    const deviceAuth = vi.fn();
    const OAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot: '/repo',
      env: {
        VERCEL_TOKEN: 'token',
        VERCEL_TEAM_ID: 'team',
      },
      deviceAuth,
      deviceAuthPrimitives: { OAuth },
    })).rejects.toThrow(/projectId/i);

    expect(deviceAuth).not.toHaveBeenCalled();
    expect(OAuth).not.toHaveBeenCalled();
  });

  it('decodes the OIDC payload scope without verifying the JWT signature', async () => {
    const oidc = `header.${Buffer.from(JSON.stringify({
      owner_id: 'team-from-oidc',
      project_id: 'project-from-oidc',
    })).toString('base64url')}.unverified-signature`;
    const deviceAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot: '/repo',
      env: { VERCEL_OIDC_TOKEN: oidc },
      deviceAuth,
    })).resolves.toEqual({
      token: oidc,
      teamId: 'team-from-oidc',
      projectId: 'project-from-oidc',
    });

    expect(deviceAuth).not.toHaveBeenCalled();
  });

  it('rejects an OIDC scope that conflicts with the linked project', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'different-team',
      projectId: 'project-from-oidc',
    }));
    const oidc = `header.${Buffer.from(JSON.stringify({
      owner_id: 'team-from-oidc',
      project_id: 'project-from-oidc',
    })).toString('base64url')}.sig`;
    const deviceAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: { VERCEL_OIDC_TOKEN: oidc },
      deviceAuth,
    })).rejects.toThrow(/scope conflict/i);

    expect(deviceAuth).not.toHaveBeenCalled();
  });

  it('trims linked and OIDC scope identifiers before comparing and returning them', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: ' linked-team ',
      projectId: ' linked-project ',
    }));
    const oidc = `header.${Buffer.from(JSON.stringify({
      owner_id: ' linked-team ',
      project_id: ' linked-project ',
    })).toString('base64url')}.sig`;

    await expect(resolveVercelCredentials({
      repoRoot,
      env: { VERCEL_OIDC_TOKEN: oidc },
    })).resolves.toMatchObject({
      teamId: 'linked-team',
      projectId: 'linked-project',
    });
  });

  it('requires a linked project before device auth', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    const deviceAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuth,
    })).rejects.toThrow(/project link is missing/i);

    expect(deviceAuth).not.toHaveBeenCalled();
  });

  it('rejects a malformed linked project before device auth', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), '{"orgId": 7}');
    const deviceAuth = vi.fn();
    const OAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuth,
      deviceAuthPrimitives: { OAuth },
    })).rejects.toThrow(/malformed.*project link/i);

    expect(deviceAuth).not.toHaveBeenCalled();
    expect(OAuth).not.toHaveBeenCalled();
  });

  it('requires a device authorization renderer on the real SDK auth path', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const OAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth },
    })).rejects.toThrow(/onDeviceAuthorization/i);
    expect(OAuth).not.toHaveBeenCalled();
  });

  it('allows a complete injected device auth function without a renderer', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const deviceAuth = vi.fn().mockResolvedValue({
      token: 'device-token',
      teamId: 'linked-team',
      projectId: 'linked-project',
    });

    await expect(resolveVercelCredentials({ repoRoot, env: {}, deviceAuth })).resolves.toEqual({
      token: 'device-token',
      teamId: 'linked-team',
      projectId: 'linked-project',
    });
    expect(deviceAuth).toHaveBeenCalledWith(
      { teamId: 'linked-team', projectId: 'linked-project' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects injected auth that overrides or omits the linked scope', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const mismatched = vi.fn().mockResolvedValue({
      token: 'device-token',
      teamId: 'other-team',
      projectId: 'linked-project',
    });
    const empty = vi.fn().mockResolvedValue({
      token: ' ',
      teamId: 'linked-team',
      projectId: 'linked-project',
    });

    await expect(resolveVercelCredentials({ repoRoot, env: {}, deviceAuth: mismatched })).rejects.toThrow(/scope mismatch/i);
    await expect(resolveVercelCredentials({ repoRoot, env: {}, deviceAuth: empty })).rejects.toThrow(/non-empty token/i);
  });

  it('cancels an injected auth function through the caller signal', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const controller = new AbortController();
    let callbackSignal: AbortSignal | undefined;
    const deviceAuth = vi.fn((_scope, context) => {
      callbackSignal = context.signal;
      return new Promise<string>(() => {});
    });
    const pending = resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuth,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(deviceAuth).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));

    await expect(pending).rejects.toThrow('caller cancelled');
    expect(callbackSignal?.aborted).toBe(true);
  });

  it('rejects a hanging injected auth function at its deadline', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuth: async () => new Promise<string>(() => {}),
      timeoutMs: 10,
    })).rejects.toThrow(/timed out/i);
  });

  it('honors an absolute authentication deadline', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuth: async () => new Promise<string>(() => {}),
      deadline: Date.now() + 10,
    })).rejects.toThrow(/timed out/i);
  });

  it('cancels OAuth construction before it can complete', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const controller = new AbortController();
    const OAuth = vi.fn(() => new Promise<never>(() => {}));
    const onDeviceAuthorization = vi.fn();
    const pending = resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth },
      onDeviceAuthorization,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(OAuth).toHaveBeenCalledOnce());
    controller.abort(new Error('oauth cancelled'));

    await expect(pending).rejects.toThrow('oauth cancelled');
    expect(OAuth).toHaveBeenCalledOnce();
    expect(onDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('cancels a hanging OAuth device request', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const controller = new AbortController();
    const oauth = {
      deviceAuthorizationRequest: vi.fn(() => new Promise<never>(() => {})),
    };
    const OAuth = vi.fn().mockResolvedValue(oauth);
    const onDeviceAuthorization = vi.fn();
    const pending = resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth },
      onDeviceAuthorization,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(OAuth).toHaveBeenCalledOnce());
    controller.abort(new Error('request cancelled'));

    await expect(pending).rejects.toThrow('request cancelled');
    expect(oauth.deviceAuthorizationRequest).toHaveBeenCalledOnce();
    expect(onDeviceAuthorization).not.toHaveBeenCalled();
  });

  it('cancels a hanging device authorization callback', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const controller = new AbortController();
    const request = {
      device_code: 'device-code',
      user_code: 'user-code',
      interval: 0,
      verification_uri: 'https://vercel.com/device',
      verification_uri_complete: 'https://vercel.com/device?code=user-code',
      expiresAt: Date.now() + 60_000,
    };
    const oauth = { deviceAuthorizationRequest: vi.fn().mockResolvedValue(request) };
    const OAuth = vi.fn().mockResolvedValue(oauth);
    const pollForToken = vi.fn();
    const onDeviceAuthorization = vi.fn(() => new Promise<void>(() => {}));
    const pending = resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth, pollForToken },
      onDeviceAuthorization,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(onDeviceAuthorization).toHaveBeenCalledOnce());
    controller.abort(new Error('callback cancelled'));

    await expect(pending).rejects.toThrow('callback cancelled');
    expect(onDeviceAuthorization).toHaveBeenCalledWith(request);
    expect(pollForToken).not.toHaveBeenCalled();
  });

  it('propagates an SDK poll error and closes the generator', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    let returned = false;
    const OAuth = vi.fn().mockResolvedValue({
      deviceAuthorizationRequest: vi.fn().mockResolvedValue({
        device_code: 'device-code',
        user_code: 'user-code',
        interval: 0,
        verification_uri: 'https://vercel.com/device',
        verification_uri_complete: 'https://vercel.com/device?code=user-code',
        expiresAt: Date.now() + 60_000,
      }),
    });
    const pollForToken = vi.fn(() => (async function* () {
      try {
        yield { _tag: 'Error' as const, error: new Error('poll failed') };
      } finally {
        returned = true;
      }
    })());
    const getAuth = vi.fn().mockReturnValue({ token: 'unused' });

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth, pollForToken, getAuth },
      onDeviceAuthorization: vi.fn(),
    })).rejects.toThrow('poll failed');
    expect(returned).toBe(true);
    expect(getAuth).not.toHaveBeenCalled();
  });

  it('cancels a pending polling iteration and requests generator cleanup', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const controller = new AbortController();
    const request = {
      device_code: 'device-code',
      user_code: 'user-code',
      interval: 0,
      verification_uri: 'https://vercel.com/device',
      verification_uri_complete: 'https://vercel.com/device?code=user-code',
      expiresAt: Date.now() + 60_000,
    };
    let returnCalled = false;
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<never>>(() => {})),
      return: vi.fn(async () => {
        returnCalled = true;
        return { done: true, value: undefined } as IteratorResult<never>;
      }),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<never>;
    const OAuth = vi.fn().mockResolvedValue({
      deviceAuthorizationRequest: vi.fn().mockResolvedValue(request),
    });
    const pollForToken = vi.fn().mockReturnValue(iterator);
    const getAuth = vi.fn();
    const pending = resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth, pollForToken, getAuth },
      onDeviceAuthorization: vi.fn(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pollForToken).toHaveBeenCalledOnce());
    controller.abort(new Error('poll cancelled'));

    await expect(pending).rejects.toThrow('poll cancelled');
    expect(returnCalled).toBe(true);
    expect(getAuth).not.toHaveBeenCalled();
  });

  it('fails when polling completes without a token', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const OAuth = vi.fn().mockResolvedValue({
      deviceAuthorizationRequest: vi.fn().mockResolvedValue({
        device_code: 'device-code',
        user_code: 'user-code',
        interval: 0,
        verification_uri: 'https://vercel.com/device',
        verification_uri_complete: 'https://vercel.com/device?code=user-code',
        expiresAt: Date.now() + 60_000,
      }),
    });
    const pollForToken = vi.fn(async function* () {
      yield { _tag: 'Response' as const, response: { text: async () => '{}' } };
    });
    const getAuth = vi.fn().mockReturnValue(null);

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth, pollForToken, getAuth },
      onDeviceAuthorization: vi.fn(),
    })).rejects.toThrow(/without a token/i);
  });

  it('uses injected SDK auth primitives for device authentication', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'devbox-auth-'));
    await mkdir(join(repoRoot, '.vercel'));
    await writeFile(join(repoRoot, '.vercel', 'project.json'), JSON.stringify({
      orgId: 'linked-team',
      projectId: 'linked-project',
    }));
    const oauth = {
      deviceAuthorizationRequest: vi.fn().mockResolvedValue({
        device_code: 'device-code',
        user_code: 'user-code',
        interval: 0,
        verification_uri: 'https://vercel.com/device',
        verification_uri_complete: 'https://vercel.com/device?code=user-code',
        expiresAt: Date.now() + 60_000,
      }),
    };
    const OAuth = vi.fn().mockResolvedValue(oauth);
    const pollForToken = vi.fn(async function* () {
      yield { _tag: 'Response' as const, response: { text: async () => '{}' } };
    });
    const getAuth = vi.fn().mockReturnValue({ token: 'device-token' });
    const onDeviceAuthorization = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: {},
      deviceAuthPrimitives: { OAuth, pollForToken, getAuth },
      onDeviceAuthorization,
    })).resolves.toEqual({
      token: 'device-token',
      teamId: 'linked-team',
      projectId: 'linked-project',
    });

    expect(OAuth).toHaveBeenCalledOnce();
    expect(pollForToken).toHaveBeenCalledOnce();
    expect(getAuth).toHaveBeenCalledOnce();
    expect(onDeviceAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      user_code: 'user-code',
    }));
  });

  it('renders and confirms the resolved scope through an injectable boundary', async () => {
    const boundary = {
      render: vi.fn().mockReturnValue('Vercel team: team\nVercel project: project'),
      confirm: vi.fn().mockResolvedValue(true),
    };

    await expect(confirmVercelScope({
      teamId: 'team',
      projectId: 'project',
    }, boundary)).resolves.toBeUndefined();

    expect(boundary.render).toHaveBeenCalledWith({ teamId: 'team', projectId: 'project' });
    expect(boundary.confirm).toHaveBeenCalledWith(
      'Vercel team: team\nVercel project: project',
      { teamId: 'team', projectId: 'project' },
    );
  });

  it('stops before creation when scope confirmation is refused', async () => {
    const boundary = {
      render: vi.fn().mockReturnValue('Vercel team: team\nVercel project: project'),
      confirm: vi.fn().mockReturnValue(false),
    };

    await expect(confirmVercelScope({
      teamId: 'team',
      projectId: 'project',
    }, boundary)).rejects.toThrow(/confirmation was refused/i);
  });
});
