import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Zero-dependency cross-process advisory lock for gating heavy store maintenance.
 *
 * WAL already makes concurrent reads/writes safe across processes, so this lock is
 * NOT used for normal reads/writes. It only prevents multiple OpenCode instances from
 * running duplicate background maintenance (retention prune, summary rebuild, FTS
 * refresh) at the same time. Acquisition is best-effort: on any unexpected filesystem
 * error we behave as if the lock could not be taken rather than throwing.
 */

const STALE_LOCK_TTL_MS = 10 * 60 * 1000;

interface MaintenanceLockFile {
  pid: number;
  createdAt: number;
}

export interface MaintenanceLock {
  /**
   * Best-effort release. Only unlinks the lock file if it still contains our pid,
   * so we never delete a successor process's lock. Swallows all errors.
   */
  release(): void;
}

function readLockFile(lockPath: string): MaintenanceLockFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pid !== 'number' || typeof record.createdAt !== 'number') {
    return undefined;
  }
  return { pid: record.pid, createdAt: record.createdAt };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission to signal it: treat as alive.
    if (code === 'EPERM') return true;
    // ESRCH (or anything else) means the process is gone.
    return false;
  }
}

function isLockHeldByLiveProcess(lockPath: string): boolean {
  const existing = readLockFile(lockPath);
  // Unparseable / malformed lock files are treated as stale and reclaimable.
  if (!existing) return false;
  if (Date.now() - existing.createdAt > STALE_LOCK_TTL_MS) return false;
  return isProcessAlive(existing.pid);
}

function tryCreateLock(lockPath: string): MaintenanceLock | undefined {
  const payload: MaintenanceLockFile = { pid: process.pid, createdAt: Date.now() };
  try {
    writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    // Unexpected error (e.g. missing directory, permission): behave as not acquired.
    return undefined;
  }
  return makeLockHandle(lockPath);
}

function makeLockHandle(lockPath: string): MaintenanceLock {
  return {
    release(): void {
      const current = readLockFile(lockPath);
      // Only unlink if the file still belongs to us; never delete a successor's lock.
      if (!current || current.pid !== process.pid) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort; a leftover lock will be reclaimed as stale by the next acquirer.
      }
    },
  };
}

/**
 * Attempts to acquire the maintenance lock at `lockPath`. Returns a {@link MaintenanceLock}
 * handle on success, or `undefined` when another live process currently holds the lock.
 *
 * A pre-existing lock is reclaimed (broken once, then re-acquired) when it is unparseable,
 * older than {@link STALE_LOCK_TTL_MS}, or owned by a dead pid. Never throws.
 */
export function acquireMaintenanceLock(lockPath: string): MaintenanceLock | undefined {
  const first = tryCreateLock(lockPath);
  if (first) return first;

  // The file already exists (or creation failed). Decide whether it is reclaimable.
  if (isLockHeldByLiveProcess(lockPath)) return undefined;

  try {
    unlinkSync(lockPath);
  } catch (error) {
    // Someone removed it first, or we cannot remove it. If it is gone, retry will succeed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }

  // Retry acquisition exactly once after breaking the stale lock.
  return tryCreateLock(lockPath);
}
