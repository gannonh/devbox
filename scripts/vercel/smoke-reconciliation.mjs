export const SMOKE_NAME_PREFIX = 'devbox-vercel-v-provider-smoke-';
export const SMOKE_VERSION_PREFIX = 'v-provider-smoke-run-';

const SMOKE_NAME_PATTERN = new RegExp(`^${SMOKE_NAME_PREFIX}[a-z0-9-]+-([a-f0-9]{16})$`);
const SMOKE_VERSION_PATTERN = new RegExp(`^${SMOKE_VERSION_PREFIX}[a-z0-9-]+-[a-f0-9]{16}$`);
const IDENTITY_TAG_KEYS = ['branch', 'identity', 'provider', 'repository', 'version'];

/** Return true only for the exact identity shape created by provider-smoke. */
export function isSmokeOwnedSandbox(record, repositoryTag) {
  if (!record || typeof record.name !== 'string') return false;
  const nameMatch = SMOKE_NAME_PATTERN.exec(record.name);
  if (!nameMatch) return false;
  const tags = record.tags;
  if (!tags || Object.keys(tags).sort().join('\0') !== IDENTITY_TAG_KEYS.join('\0')) return false;
  if (tags.provider !== 'vercel' || tags.repository !== repositoryTag) return false;
  if (!isSafeTagValue(tags.branch) || !SMOKE_VERSION_PATTERN.test(tags.version) || !/^[a-f0-9]{16}$/.test(tags.identity) || nameMatch[1] !== tags.identity) {
    return false;
  }
  return true;
}

/** Locally filter a fully paginated list; server-side filters are advisory only. */
export function selectSmokeOwnedSandboxes(records, repositoryTag) {
  const owned = [];
  const ignored = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (isSmokeOwnedSandbox(record, repositoryTag)) {
      owned.push(record);
    } else if (record && typeof record.name === 'string' && record.name.startsWith(SMOKE_NAME_PREFIX)) {
      ignored.push(record);
    }
  }
  return { owned, ignored };
}

function isSafeTagValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 63 && [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x20 && code !== 0x7f;
  });
}
