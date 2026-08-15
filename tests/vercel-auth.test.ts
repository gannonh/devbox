import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirmVercelScope,
  resolveVercelCredentials,
} from '../src/providers/vercel/auth.js';

describe('Vercel credential resolution', () => {
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
    })).toString('base64url')}.signature`;
    const deviceAuth = vi.fn();

    await expect(resolveVercelCredentials({
      repoRoot,
      env: { VERCEL_OIDC_TOKEN: oidc },
      deviceAuth,
    })).rejects.toThrow(/scope conflict/i);

    expect(deviceAuth).not.toHaveBeenCalled();
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
