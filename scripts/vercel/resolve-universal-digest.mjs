#!/usr/bin/env node
/**
 * Resolve the current digest behind Vercel's managed Universal image by
 * creating a short-lived Sandbox. This avoids relying on a floating tag in a
 * Dockerfile while allowing the scheduled workflow to detect upstream drift.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { APIError, Sandbox, Snapshot } from '@vercel/sandbox';
import { boundedCall, verifySandboxDeleted } from './sandbox-cleanup.mjs';
import { recoverOwnedResources } from './sandbox-owned-recovery.mjs';
import { deleteListedSnapshot } from './snapshot-cleanup.mjs';

function positiveTimeout(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return Math.ceil(value);
}

const probeTimeoutMs = positiveTimeout('BASE_DIGEST_TIMEOUT_MS', 120_000);
const sdkTimeoutMs = positiveTimeout('BASE_DIGEST_SDK_TIMEOUT_MS', 30_000);
const cleanupTimeoutMs = positiveTimeout('BASE_DIGEST_CLEANUP_TIMEOUT_MS', 120_000);
const startedEpochMs = Date.now();
const reportPath = process.env.BASE_DIGEST_EVIDENCE;
const credentials = {
  ...(process.env.VERCEL_TOKEN ? { token: process.env.VERCEL_TOKEN } : {}),
  ...(process.env.VERCEL_TEAM_ID ? { teamId: process.env.VERCEL_TEAM_ID } : {}),
  ...(process.env.VERCEL_PROJECT_ID ? { projectId: process.env.VERCEL_PROJECT_ID } : {}),
};
const ownedId = randomBytes(12).toString('hex');
const ownedName = `base-digest-probe-${ownedId}`;
const ownedTag = `base-digest-probe-${ownedId}`;
const report = {
  operation: 'resolve-universal-digest',
  requestedImage: 'vercel/sandbox/universal',
  startedAt: new Date(startedEpochMs).toISOString(),
  credentials: { scopedProject: Boolean(credentials.projectId), tokenSupplied: Boolean(credentials.token) },
  ownedName,
  ownedTag,
  cleanup: { stopAttempted: false, deleteAttempted: false, deletionVerified: false, discoveryConverged: false, snapshotsCleaned: false, errors: [] },
};
const probeController = new AbortController();
const probeTimer = setTimeout(() => probeController.abort(new Error(`Universal digest probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs);
const probeSignal = probeController.signal;
let activeDeadlineAt = startedEpochMs + probeTimeoutMs;
let sandbox;
let primaryVerification;
let evidenceWriteError;

function isNotFound(error) {
  return error instanceof APIError && [404, 410].includes(error.response.status);
}

function isTransient(error) {
  return error instanceof APIError && [409, 422].includes(error.response.status) &&
    ['sandbox_stopping', 'sandbox_snapshotting'].includes(error.json?.error?.code);
}

function remaining(signal) {
  if (signal.aborted) return 0;
  return Math.max(1, activeDeadlineAt - Date.now());
}

async function listOwnedSandboxes(signal) {
  return boundedCall(
    (requestSignal) => Sandbox.list({ ...credentials, namePrefix: ownedName, tags: { 'devbox-run': ownedTag }, signal: requestSignal })
      .then((page) => page.toArray())
      .then((sandboxes) => sandboxes.filter((item) => item.name === ownedName)),
    'owned Sandbox discovery',
    { signal, timeoutMs: Math.min(sdkTimeoutMs, remaining(signal)) },
  );
}

async function listOwnedSnapshots(signal) {
  return boundedCall(
    (requestSignal) => Snapshot.list({ ...credentials, name: ownedName, limit: 100, signal: requestSignal }).then((page) => page.toArray()),
    'owned snapshot discovery',
    { signal, timeoutMs: Math.min(sdkTimeoutMs, remaining(signal)) },
  );
}

async function verifyResource(name, signal) {
  // verifySandboxDeleted performs every post-delete lookup with resume: false.
  const result = await verifySandboxDeleted({
    timeoutMs: Math.min(cleanupTimeoutMs, remaining(signal)),
    operationTimeoutMs: sdkTimeoutMs,
    signal,
    getSandbox: (options) => Sandbox.get({ ...credentials, name, ...options }),
    listSessions: (target, options) => target.listSessions({ limit: 100, sortOrder: 'asc', signal: options.signal }).then((page) => page.toArray()),
    stopSandbox: (target, options) => target.stop(options),
    deleteSandbox: (target, options) => target.delete(options),
    isNotFound,
    isTransient,
  });
  if (result.errors.length > 0) report.cleanup.errors.push(...result.errors);
  return result;
}

async function recoverOwned(signal) {
  const recovery = await recoverOwnedResources({
    timeoutMs: cleanupTimeoutMs,
    operationTimeoutMs: sdkTimeoutMs,
    listSandboxes: ({ signal: requestSignal }) => listOwnedSandboxes(requestSignal),
    recoverSandbox: async (name, { signal: requestSignal }) => {
      const result = await verifyResource(name, requestSignal);
      if (!result.verified || !result.noRunningSession) throw new Error(`owned Sandbox ${name} was not fully deleted`);
    },
    listSnapshots: ({ signal: requestSignal }) => listOwnedSnapshots(requestSignal),
    deleteSnapshot: (snapshot, { signal: requestSignal }) => deleteListedSnapshot({
      snapshot,
      signal: requestSignal,
      timeoutMs: Math.min(sdkTimeoutMs, remaining(requestSignal)),
      label: 'owned snapshot',
      getSnapshot: (snapshotId, getSignal) => Snapshot.get({ ...credentials, snapshotId, signal: getSignal }),
    }),
    signal,
    isNotFound,
  });
  report.cleanup.errors.push(...recovery.errors);
  report.cleanup.ownedSandboxesRecovered = recovery.recoveredSandboxes;
  report.cleanup.ownedSnapshotsDeleted = recovery.deletedSnapshots;
  report.cleanup.residualSnapshots = recovery.residualSnapshots;
  report.cleanup.finalSnapshots = recovery.finalSnapshots;
  report.cleanup.snapshotsCleaned = recovery.snapshotsCleaned;
  report.cleanup.discoveryConverged = recovery.discoveryConverged;
  return recovery;
}

try {
  sandbox = await boundedCall(
    (signal) => Sandbox.create({
      ...credentials,
      name: ownedName,
      image: 'vercel/sandbox/universal',
      timeout: probeTimeoutMs,
      persistent: false,
      tags: { 'devbox-image': 'base-digest-probe', 'devbox-run': ownedTag },
      signal,
    }),
    'Universal digest Sandbox create',
    { signal: probeSignal, timeoutMs: Math.min(probeTimeoutMs, remaining(probeSignal)) },
  );
  const resolved = sandbox.image ?? '';
  const match = /@(?<digest>sha256:[a-f0-9]{64})$/i.exec(resolved);
  if (!match) throw new Error('Sandbox did not return a full Universal manifest digest');
  report.resolvedImage = resolved.replace(/@sha256:.+$/, '@[digest]');
  report.digest = match.groups.digest;
  console.log(match.groups.digest);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  clearTimeout(probeTimer);
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => cleanupController.abort(new Error(`Universal digest cleanup timed out after ${cleanupTimeoutMs}ms`)), cleanupTimeoutMs);
  const cleanupSignal = cleanupController.signal;
  activeDeadlineAt = Date.now() + cleanupTimeoutMs;
  if (sandbox) {
    report.cleanup.stopAttempted = true;
    try {
      await boundedCall(
        (signal) => sandbox.stop({ signal }),
        'Universal digest Sandbox stop',
        { signal: cleanupSignal, timeoutMs: Math.min(sdkTimeoutMs, cleanupTimeoutMs) },
      );
    } catch (error) {
      if (!isNotFound(error)) report.cleanup.errors.push(`stop: ${error instanceof Error ? error.message : String(error)}`);
    }
    report.cleanup.deleteAttempted = true;
    try {
      await boundedCall(
        (signal) => sandbox.delete({ signal }),
        'Universal digest Sandbox delete',
        { signal: cleanupSignal, timeoutMs: Math.min(sdkTimeoutMs, cleanupTimeoutMs) },
      );
    } catch (error) {
      if (!isNotFound(error)) report.cleanup.errors.push(`delete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    primaryVerification = await verifyResource(ownedName, cleanupSignal);
    report.cleanup.primaryVerification = {
      verified: primaryVerification.verified,
      noRunningSession: primaryVerification.noRunningSession,
    };
  } catch (error) {
    report.cleanup.errors.push(`primary verification: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const recovery = await recoverOwned(cleanupSignal);
    report.cleanup.deletionVerified = Boolean(
      recovery.discoveryConverged &&
      recovery.snapshotsCleaned &&
      recovery.errors.length === 0 &&
      ((primaryVerification?.verified && primaryVerification?.noRunningSession) ||
        recovery.recoveredSandboxes.length > 0),
    );
  } catch (error) {
    report.cleanup.errors.push(`owned recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  clearTimeout(cleanupTimer);
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedEpochMs;
  if (reportPath) {
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      evidenceWriteError = error;
    }
  }
}

if (!report.digest || report.cleanup.errors.length > 0 || !report.cleanup.snapshotsCleaned || !report.cleanup.deletionVerified || evidenceWriteError) {
  process.exitCode = 1;
  if (!report.error) report.error = report.cleanup.errors[0] ?? 'Universal digest probe cleanup or resolution failed';
  const messages = [report.error];
  if (evidenceWriteError) messages.push(`evidence write failed: ${evidenceWriteError instanceof Error ? evidenceWriteError.message : String(evidenceWriteError)}`);
  console.error(messages.join('; '));
}
