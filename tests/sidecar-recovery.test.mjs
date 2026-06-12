import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildChildEnv } from '../dist/node-sidecar-env.js';
import { NodeSidecarLcmStore } from '../dist/node-sidecar-store.js';
import { cleanupWorkspace, makeOptions, makeWorkspace } from './helpers.mjs';

test('sidecar automatically respawns and replays init after the child is killed', async () => {
  const workspace = makeWorkspace('lcm-sidecar-restart');
  const store = new NodeSidecarLcmStore(workspace, makeOptions());
  try {
    await store.init();
    await store.stats();

    const originalPid = store.getChildPidForTests();
    assert.equal(typeof originalPid, 'number');

    // Kill the live child and wait for the internal exit handler to clear it.
    const exited = store.waitForExitForTests();
    store.killChildForTests();
    await exited;

    // The next request must transparently respawn the sidecar and replay init,
    // so a method that needs an initialized store still succeeds.
    const stats = await store.stats();
    assert.ok(stats);
    assert.equal(typeof stats.sessionCount, 'number');

    const newPid = store.getChildPidForTests();
    assert.equal(typeof newPid, 'number');
    assert.notEqual(newPid, originalPid);
  } finally {
    store.close();
    await store.waitForExitForTests();
    await cleanupWorkspace(workspace);
  }
});

test('sidecar fails fast after exceeding the consecutive restart cap', {
  skip: process.platform === 'win32' ? 'requires a POSIX fast-exit binary' : false,
}, async () => {
  // A tiny executable that ignores its args, lingers briefly so the client's
  // write always buffers, then exits non-zero — simulating a sidecar that
  // crashes immediately on every spawn.
  const binDir = mkdtempSync(path.join(tmpdir(), 'lcm-fast-exit-'));
  const binPath = path.join(binDir, 'fast-exit.sh');
  writeFileSync(binPath, '#!/bin/sh\nsleep 0.3\nexit 1\n');
  chmodSync(binPath, 0o755);

  const previousNodePath = process.env.OPENCODE_LCM_NODE_PATH;
  process.env.OPENCODE_LCM_NODE_PATH = binPath;

  const workspace = makeWorkspace('lcm-sidecar-crashloop');
  const store = new NodeSidecarLcmStore(workspace, makeOptions());
  try {
    let capError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await store.stats();
      } catch (error) {
        if (/consecutive restart attempts/.test(error.message)) {
          capError = error;
          break;
        }
      }
    }
    assert.ok(capError, 'expected a fail-fast error after the restart cap');
    assert.match(capError.message, /refusing to respawn/);
  } finally {
    store.close();
    if (previousNodePath === undefined) delete process.env.OPENCODE_LCM_NODE_PATH;
    else process.env.OPENCODE_LCM_NODE_PATH = previousNodePath;
    await cleanupWorkspace(workspace);
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('oversized request is rejected cleanly without killing the sidecar', async () => {
  const previousCap = process.env.OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES;
  process.env.OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES = '16384';

  const workspace = makeWorkspace('lcm-sidecar-oversized');
  // Construct after the env override so the client picks up the lowered cap.
  const store = new NodeSidecarLcmStore(workspace, makeOptions());
  try {
    await store.init();

    const big = 'x'.repeat(50000);
    await assert.rejects(
      () => store.grep({ query: big }),
      /exceeding the 16384-byte message limit/,
    );

    // The sidecar must still be alive for ordinary requests.
    const stats = await store.stats();
    assert.ok(stats);
    assert.equal(typeof stats.sessionCount, 'number');
  } finally {
    store.close();
    await store.waitForExitForTests();
    if (previousCap === undefined) delete process.env.OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES;
    else process.env.OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES = previousCap;
    await cleanupWorkspace(workspace);
  }
});

test('malformed server line does not break subsequent requests', { timeout: 20000 }, async () => {
  const sidecarScript = fileURLToPath(new URL('../dist/node-sidecar.js', import.meta.url));
  const workspace = makeWorkspace('lcm-sidecar-malformed');
  const child = spawn(process.execPath, ['--no-warnings', sidecarScript], {
    env: buildChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');

  const responses = new Map();
  let buffer = '';
  const sawStats = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line);
        responses.set(parsed.id, parsed);
        if (parsed.id === 2) resolve(parsed);
      }
    });
  });

  try {
    // A garbage line first, then a valid init + stats request.
    child.stdin.write('this is not valid json {{{\n');
    child.stdin.write(
      `${JSON.stringify({ id: 1, method: 'init', params: { projectDir: workspace, options: makeOptions() } })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ id: 2, method: 'stats' })}\n`);

    const statsResponse = await sawStats;
    // The malformed line must not have short-circuited the chain.
    assert.ok('result' in statsResponse, 'stats request should resolve to a result');
    const initResponse = responses.get(1);
    assert.ok(initResponse, 'init request should have produced a response');
    assert.ok('result' in initResponse);
  } finally {
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ id: 3, method: 'close' })}\n`);
      child.stdin.end();
    }
    await once(child, 'exit');
    await cleanupWorkspace(workspace);
  }
});
