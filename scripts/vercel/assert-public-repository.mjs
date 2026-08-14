#!/usr/bin/env node
/**
 * Verify the flat VCR repository response and its direct project correlation.
 * Team/project ownership is checked separately from scoped project/team API
 * responses; the repository endpoint does not expose those nested objects.
 */
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

const expectedProjectId = option('expected-project-id', 'EXPECTED_PROJECT_ID');
const expectedRepository = option('expected-repository', 'EXPECTED_REPOSITORY');
const expectedRepositoryId = option('expected-repository-id', 'EXPECTED_REPOSITORY_ID');
if (!expectedProjectId || !expectedRepository) {
  throw new Error('expected project ID and repository name are required for VCR identity verification');
}

const repository = value.repository && typeof value.repository === 'object' ? value.repository : value;
if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
  throw new Error('VCR repository inspection did not return a repository object');
}

function normalizedVisibility(candidate) {
  if (candidate === true) return true;
  if (typeof candidate !== 'string') return false;
  const normalized = candidate.trim().toLowerCase();
  return normalized === 'true' || normalized === 'public';
}

if (!normalizedVisibility(repository.public ?? repository.visibility)) {
  throw new Error('VCR repository is not public; perform the one-time operator visibility change, then rerun this workflow');
}
if (typeof repository.id !== 'string' || repository.id.length === 0) {
  throw new Error('VCR repository response is missing its repository ID');
}
if (expectedRepositoryId && repository.id !== expectedRepositoryId) {
  throw new Error('VCR repository ID does not match the expected repository');
}
if (repository.name !== expectedRepository) {
  throw new Error('VCR repository name does not match the expected repository');
}
if (repository.projectId !== expectedProjectId) {
  throw new Error('VCR repository project ID does not match the expected publisher project');
}
console.log('VCR repository visibility and repository/project identity: verified');
