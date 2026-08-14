#!/usr/bin/env node
/** Verify VCR repository visibility and the returned repository/project identity. */
let input = '';
for await (const chunk of process.stdin) input += chunk;
let value;
try {
  const start = input.indexOf('{');
  if (start < 0) throw new Error('no JSON object');
  value = JSON.parse(input.slice(start));
} catch {
  throw new Error('VCR repository inspection did not return JSON');
}

function option(name, envName) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : process.env[envName];
}

const expected = {
  teamId: option('expected-team-id', 'EXPECTED_TEAM_ID'),
  projectId: option('expected-project-id', 'EXPECTED_PROJECT_ID'),
  teamSlug: option('expected-team-slug', 'EXPECTED_TEAM_SLUG'),
  projectSlug: option('expected-project-slug', 'EXPECTED_PROJECT_SLUG'),
  repository: option('expected-repository', 'EXPECTED_REPOSITORY'),
};
for (const [name, item] of Object.entries(expected)) {
  if (!item) throw new Error(`expected ${name} is required for VCR identity verification`);
}

function normalizedVisibility(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'public';
}

function collectIdentity(node, context = 'root', identity = {
  teamIds: new Set(),
  projectIds: new Set(),
  teamSlugs: new Set(),
  projectSlugs: new Set(),
  repositories: new Set(),
  visibility: [],
}) {
  if (!node || typeof node !== 'object') return identity;
  for (const [key, child] of Object.entries(node)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (normalizedKey === 'public' || normalizedKey === 'visibility') {
      identity.visibility.push(child);
    }
    if (typeof child === 'string') {
      if (['teamid', 'ownerid'].includes(normalizedKey)) identity.teamIds.add(child);
      if (normalizedKey === 'projectid') identity.projectIds.add(child);
      if (['teamslug', 'ownerslug', 'team'].includes(normalizedKey)) identity.teamSlugs.add(child);
      if (['projectslug', 'project'].includes(normalizedKey)) identity.projectSlugs.add(child);
      if (['repository', 'repositoryname', 'repo', 'reponame', 'name'].includes(normalizedKey)) {
        identity.repositories.add(child);
      }
      if (normalizedKey === 'id' && context === 'team') identity.teamIds.add(child);
      if (normalizedKey === 'id' && context === 'project') identity.projectIds.add(child);
      if (normalizedKey === 'slug' && context === 'team') identity.teamSlugs.add(child);
      if (normalizedKey === 'slug' && context === 'project') identity.projectSlugs.add(child);
    }
    const nextContext = ['team', 'owner'].includes(normalizedKey)
      ? 'team'
      : normalizedKey === 'project'
        ? 'project'
        : ['repository', 'repo', 'image'].includes(normalizedKey)
          ? 'repository'
          : context;
    collectIdentity(child, nextContext, identity);
  }
  return identity;
}

function has(set, expectedValue) {
  return set.has(expectedValue);
}

const identity = collectIdentity(value);
if (!identity.visibility.some(normalizedVisibility)) {
  throw new Error('VCR repository is not public; perform the one-time operator visibility change, then rerun this workflow');
}
if (!has(identity.teamIds, expected.teamId)) throw new Error('VCR repository identity does not match the expected team ID');
if (!has(identity.projectIds, expected.projectId)) throw new Error('VCR repository identity does not match the expected project ID');
if (!has(identity.teamSlugs, expected.teamSlug)) throw new Error('VCR repository identity does not match the expected team slug');
if (!has(identity.projectSlugs, expected.projectSlug)) throw new Error('VCR repository identity does not match the expected project slug');
if (!has(identity.repositories, expected.repository)) throw new Error('VCR repository identity does not match the expected repository');
console.log('VCR repository visibility and identity: verified');
