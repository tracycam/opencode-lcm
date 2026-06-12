import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SqliteLcmStore } from '../dist/store.js';
import { cleanupWorkspace, makeOptions, makeWorkspace, sessionInfo, userInfo } from './helpers.mjs';

function lockPath(workspace) {
  return path.join(workspace, '.lcm', 'maintenance.lock');
}

function writeLiveLock(workspace) {
  // The current test process pid is alive, so this models a peer instance holding the lock.
  writeFileSync(lockPath(workspace), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
}

async function seedStaleSession(store, workspace, sessionID) {
  await store.capture({
    type: 'session.created',
    properties: { sessionID, info: sessionInfo(workspace, sessionID, 1) },
  });
  await store.capture({
    type: 'message.updated',
    properties: { sessionID, info: userInfo(sessionID, `${sessionID}-m`, 2) },
  });
  await store.capture({
    type: 'message.part.updated',
    properties: {
      sessionID,
      time: 2,
      part: {
        id: `${sessionID}-p`,
        sessionID,
        messageID: `${sessionID}-m`,
        type: 'text',
        text: `stale content for ${sessionID}`,
      },
    },
  });
}

const retentionOnlyStale = {
  retention: { staleSessionDays: 0, deletedSessionDays: undefined, orphanBlobDays: undefined },
};

test('chunked retention prune deletes multiple stale sessions with accurate counts', async () => {
  const workspace = makeWorkspace('lcm-chunked-prune');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions(retentionOnlyStale));
    await store.init();
    await seedStaleSession(store, workspace, 's1');
    await seedStaleSession(store, workspace, 's2');
    await seedStaleSession(store, workspace, 's3');

    const before = await store.stats();
    assert.equal(before.sessionCount, 3);

    const applied = await store.retentionPrune({ staleSessionDays: 0, apply: true });
    assert.match(applied, /deleted_sessions=3/);
    assert.match(applied, /status=applied/);

    const after = await store.stats();
    assert.equal(after.sessionCount, 0, 'all stale sessions should be pruned across chunks');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

// NOTE: A partial-failure case (one session's deletion throws, leaving earlier deletions
// committed) is not simulated here: clearSessionDataSync is private and there is no clean,
// non-internal seam to force a single chunk to fail without monkeypatching internals.
// The chunking semantics (each session in its own transaction) are exercised by the
// multi-session test above; partial progress is guaranteed by per-session commits.

test('explicit retention prune is gated while another process holds the lock', async () => {
  const workspace = makeWorkspace('lcm-prune-locked');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions(retentionOnlyStale));
    await store.init();
    await seedStaleSession(store, workspace, 'drop');

    writeLiveLock(workspace);
    const blocked = await store.retentionPrune({ staleSessionDays: 0, apply: true });
    assert.match(blocked, /maintenance is already running in another OpenCode instance/);

    const held = await store.stats();
    assert.equal(held.sessionCount, 1, 'session must survive while the lock is held');

    rmSync(lockPath(workspace), { force: true });
    const applied = await store.retentionPrune({ staleSessionDays: 0, apply: true });
    assert.match(applied, /deleted_sessions=1/);

    const after = await store.stats();
    assert.equal(after.sessionCount, 0, 'prune should proceed once the lock is released');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('deferred maintenance is skipped while the lock is held, then proceeds once released', async () => {
  const workspace = makeWorkspace('lcm-deferred-locked');
  let store;

  try {
    // Seed a stale session and persist it to disk.
    store = new SqliteLcmStore(workspace, makeOptions(retentionOnlyStale));
    await store.init();
    await seedStaleSession(store, workspace, 'drop');
    const seeded = await store.stats();
    assert.equal(seeded.sessionCount, 1);
    store.close();

    // Reopen with a peer process holding the maintenance lock: deferred prune must skip.
    writeLiveLock(workspace);
    store = new SqliteLcmStore(workspace, makeOptions(retentionOnlyStale));
    await store.init();
    const locked = await store.stats();
    assert.equal(locked.sessionCount, 1, 'deferred prune must be skipped while locked');
    store.close();

    // Release the lock and reopen: deferred prune should now run at startup.
    rmSync(lockPath(workspace), { force: true });
    store = new SqliteLcmStore(workspace, makeOptions(retentionOnlyStale));
    await store.init();
    const released = await store.stats();
    assert.equal(released.sessionCount, 0, 'deferred prune should proceed once the lock is gone');
  } finally {
    store?.close();
    await cleanupWorkspace(workspace);
  }
});
