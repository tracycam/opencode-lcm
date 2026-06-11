import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exportStoreSnapshot, importStoreSnapshot } from '../dist/store-snapshot.js';

function makeWorkspace() {
  return mkdtempSync(path.join(os.tmpdir(), 'lcm-snap-escape-'));
}

function makeExportBindings(workspaceDirectory) {
  return {
    workspaceDirectory,
    normalizeScope: (scope) => scope ?? 'session',
    resolveScopeSessionIDs: () => undefined,
    readScopedSessionRowsSync: () => [],
    readScopedMessageRowsSync: () => [],
    readScopedPartRowsSync: () => [],
    readScopedResumeRowsSync: () => [],
    readScopedArtifactRowsSync: () => [],
    readScopedArtifactBlobRowsSync: () => [],
    readScopedSummaryRowsSync: () => [],
    readScopedSummaryEdgeRowsSync: () => [],
    readScopedSummaryStateRowsSync: () => [],
  };
}

function makeImportBindings(workspaceDirectory) {
  return {
    workspaceDirectory,
    getDb: () => {
      throw new Error('getDb must not be reached when the path is rejected');
    },
    clearSessionDataSync: () => {},
    backfillArtifactBlobsSync: () => {},
    refreshAllLineageSync: () => {},
    syncAllDerivedSessionStateSync: () => {},
    refreshSearchIndexesSync: () => {},
  };
}

test('exportStoreSnapshot rejects absolute paths outside the workspace', async () => {
  const ws = makeWorkspace();
  const evil = path.join(os.tmpdir(), `lcm-evil-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    await assert.rejects(
      () => exportStoreSnapshot(makeExportBindings(ws), { filePath: evil }),
      /Path must stay within the workspace/,
    );
    assert.equal(existsSync(evil), false, 'snapshot must NOT be written outside the workspace');
  } finally {
    if (existsSync(evil)) unlinkSync(evil);
    rmSync(ws, { recursive: true, force: true });
  }
});

test('importStoreSnapshot rejects absolute paths outside the workspace', async () => {
  const ws = makeWorkspace();
  try {
    await assert.rejects(
      () => importStoreSnapshot(makeImportBindings(ws), { filePath: '/etc/passwd' }),
      /Path must stay within the workspace/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('exportStoreSnapshot still accepts relative paths within the workspace', async () => {
  const ws = makeWorkspace();
  try {
    const summary = await exportStoreSnapshot(makeExportBindings(ws), { filePath: 'backup.json' });
    const expected = path.join(ws, 'backup.json');
    assert.ok(summary.includes(`file=${expected}`), `summary should reference ${expected}`);
    assert.equal(existsSync(expected), true, 'relative snapshot must be written inside workspace');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('exportStoreSnapshot still accepts absolute paths inside the workspace', async () => {
  const ws = makeWorkspace();
  const abs = path.join(ws, 'backup.json');
  try {
    const summary = await exportStoreSnapshot(makeExportBindings(ws), { filePath: abs });
    assert.ok(summary.includes(`file=${abs}`), `summary should reference ${abs}`);
    assert.equal(existsSync(abs), true, 'absolute in-workspace snapshot must be written');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
