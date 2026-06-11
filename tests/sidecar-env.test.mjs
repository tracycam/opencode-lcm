import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildChildEnv, nodeExecutable } from '../dist/node-sidecar-env.js';
import { NodeSidecarLcmStore } from '../dist/node-sidecar-store.js';
import { makeOptions } from './helpers.mjs';

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) previous[key] = process.env[key];
  for (const key of keys) {
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

test('nodeExecutable ignores a relative or nonexistent OPENCODE_LCM_NODE_PATH override', () => {
  // Relative path → rejected.
  withEnv({ OPENCODE_LCM_NODE_PATH: 'evil-node', NODE: undefined }, () => {
    let result;
    const stderr = captureStderr(() => {
      result = nodeExecutable();
    });
    assert.equal(result, 'node');
    assert.match(stderr, /ignoring invalid OPENCODE_LCM_NODE_PATH/);
    assert.match(stderr, /evil-node/);
  });

  // Absolute but nonexistent path → rejected.
  const bogus = path.join(tmpdir(), 'opencode-lcm-nonexistent-node-binary-xyz');
  withEnv({ OPENCODE_LCM_NODE_PATH: bogus, NODE: undefined }, () => {
    let result;
    const stderr = captureStderr(() => {
      result = nodeExecutable();
    });
    assert.equal(result, 'node');
    assert.match(stderr, /ignoring invalid OPENCODE_LCM_NODE_PATH/);
  });

  // Absolute existing path → accepted (use the real running node binary).
  withEnv({ OPENCODE_LCM_NODE_PATH: process.execPath }, () => {
    let result;
    const stderr = captureStderr(() => {
      result = nodeExecutable();
    });
    assert.equal(result, process.execPath);
    assert.equal(stderr, '');
  });
});

test('buildChildEnv whitelists env and strips secrets + NODE_OPTIONS', () => {
  withEnv(
    {
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      DATABASE_PASSWORD: 'hunter2',
      NODE_OPTIONS: '--require /tmp/malicious',
      OPENCODE_LCM_NODE_PATH: '/tmp/should-not-leak',
      OPENCODE_LCM_STARTUP_LOG: '1',
    },
    () => {
      const childEnv = buildChildEnv();

      // Secrets must NOT be forwarded.
      assert.equal('AWS_SECRET_ACCESS_KEY' in childEnv, false);
      assert.equal('SSH_AUTH_SOCK' in childEnv, false);
      assert.equal('DATABASE_PASSWORD' in childEnv, false);

      // NODE_OPTIONS injection vector must be stripped.
      assert.equal('NODE_OPTIONS' in childEnv, false);

      // OPENCODE_LCM_NODE_PATH must never be forwarded.
      assert.equal('OPENCODE_LCM_NODE_PATH' in childEnv, false);

      // Whitelisted + safe config vars are forwarded.
      assert.equal(childEnv.PATH, process.env.PATH);
      assert.equal(childEnv.OPENCODE_LCM_STARTUP_LOG, '1');

      // SQLite runtime is forced for the child.
      assert.equal(childEnv.OPENCODE_LCM_SQLITE_RUNTIME, 'node');
    },
  );
});

test('NodeSidecarLcmStore round-trip: init() + stats() still works', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'lcm-sidecar-env-'));
  const store = new NodeSidecarLcmStore(workspace, makeOptions());
  try {
    await store.init();
    const stats = await store.stats();
    assert.ok(stats);
    assert.equal(typeof stats, 'object');
    assert.equal(typeof stats.sessionCount, 'number');
    assert.equal(typeof stats.totalEvents, 'number');
  } finally {
    store.close();
    await store.waitForExitForTests();
    rmSync(workspace, { recursive: true, force: true });
  }
});
