import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireMaintenanceLock } from '../dist/maintenance-lock.js';

function makeLockPath() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lcm-maint-lock-'));
  return { dir, lockPath: path.join(dir, 'maintenance.lock') };
}

function deadPid() {
  // spawnSync runs the child to completion and reaps it, so its pid is no longer alive.
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(typeof result.pid === 'number' && result.pid > 0, 'expected a child pid');
  return result.pid;
}

test('acquire/release roundtrip creates and removes the lock file', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    const lock = acquireMaintenanceLock(lockPath);
    assert.ok(lock, 'should acquire the lock');
    assert.ok(existsSync(lockPath), 'lock file should exist while held');
    lock.release();
    assert.ok(!existsSync(lockPath), 'lock file should be removed after release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('second acquire returns undefined while the lock is held', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    const first = acquireMaintenanceLock(lockPath);
    assert.ok(first, 'first acquire should succeed');
    const second = acquireMaintenanceLock(lockPath);
    assert.equal(second, undefined, 'second acquire should fail while held');
    first.release();
    const third = acquireMaintenanceLock(lockPath);
    assert.ok(third, 'acquire should succeed after release');
    third.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale lock (old createdAt) is broken and reacquired', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    const oldCreatedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago, well past the TTL
    // Use the current (alive) pid to prove staleness alone is enough to reclaim.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: oldCreatedAt }));
    const lock = acquireMaintenanceLock(lockPath);
    assert.ok(lock, 'stale lock should be reclaimable');
    const refreshed = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.ok(refreshed.createdAt > oldCreatedAt, 'reacquired lock should have a fresh timestamp');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dead-pid lock is broken and reacquired', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), createdAt: Date.now() }));
    const lock = acquireMaintenanceLock(lockPath);
    assert.ok(lock, 'dead-pid lock should be reclaimable');
    const refreshed = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(refreshed.pid, process.pid, 'reacquired lock should record our pid');
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt lock file is broken and reacquired', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    writeFileSync(lockPath, 'this is not json {{{');
    const lock = acquireMaintenanceLock(lockPath);
    assert.ok(lock, 'corrupt lock should be reclaimable');
    lock.release();
    assert.ok(!existsSync(lockPath), 'lock file should be removed after release');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release does not unlink a successor lock owned by another pid', () => {
  const { dir, lockPath } = makeLockPath();
  try {
    const lock = acquireMaintenanceLock(lockPath);
    assert.ok(lock, 'should acquire the lock');
    // Simulate a successor process taking over the lock file under a different pid.
    const successor = { pid: process.pid + 1, createdAt: Date.now() };
    writeFileSync(lockPath, JSON.stringify(successor));
    lock.release();
    assert.ok(existsSync(lockPath), "successor's lock file must survive our release");
    const stillThere = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(stillThere.pid, successor.pid, 'successor lock content should be intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
