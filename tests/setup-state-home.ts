import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point XDG_STATE_HOME at a throwaway directory for every test file.
 *
 * Devbox persists per-repository state there — the remembered provider, Vercel
 * scope confirmations, branch metadata. Without this, running the suite writes
 * into the developer's real ~/.local/state and tests leak into each other: a
 * test that selects the Vercel provider would change what a later test sees.
 */
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'devbox-test-state-'));
// Provider up/attach tests often detach immediately. Without this, the default
