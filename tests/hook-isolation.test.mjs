import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoreHooks } from '../dist/index.js';

async function withCapturedStderr(run) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function throwingStore(method) {
  const store = {
    captureDeferred: async () => {},
    transformMessages: async () => {},
    systemHint: () => 'SYSTEM_HINT',
    buildCompactionContext: async () => 'COMPACTION_NOTE',
  };
  const boom = () => {
    throw new Error(`boom-${method}`);
  };
  store[method] = method === 'systemHint' ? boom : async () => boom();
  return store;
}

test('event hook swallows store.captureDeferred failures and logs to stderr', async () => {
  const hooks = createStoreHooks(throwingStore('captureDeferred'));
  const stderr = await withCapturedStderr(async () => {
    // Must resolve (not reject) even though captureDeferred throws.
    await hooks.event({ event: { type: 'session.created', properties: {} } });
  });
  assert.match(stderr, /\[opencode-lcm\] event hook failed/);
});

test('messages.transform hook swallows failures and leaves output.messages unchanged', async () => {
  const hooks = createStoreHooks(throwingStore('transformMessages'));
  const output = { messages: [{ id: 'm1', parts: [{ type: 'text', text: 'keep me' }] }] };
  const before = JSON.stringify(output.messages);
  const stderr = await withCapturedStderr(async () => {
    await hooks['experimental.chat.messages.transform']({}, output);
  });
  assert.equal(JSON.stringify(output.messages), before);
  assert.match(stderr, /\[opencode-lcm\] messages\.transform hook failed/);
});

test('system.transform hook swallows failures and leaves output.system unchanged', async () => {
  const hooks = createStoreHooks(throwingStore('systemHint'));
  const output = { system: [] };
  const stderr = await withCapturedStderr(async () => {
    await hooks['experimental.chat.system.transform']({}, output);
  });
  assert.deepEqual(output.system, []);
  assert.match(stderr, /\[opencode-lcm\] system\.transform hook failed/);
});

test('session.compacting hook swallows failures and leaves output.context unchanged', async () => {
  const hooks = createStoreHooks(throwingStore('buildCompactionContext'));
  const output = { context: [], prompt: 'keep-default' };
  const stderr = await withCapturedStderr(async () => {
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, output);
  });
  assert.deepEqual(output.context, []);
  assert.equal(output.prompt, 'keep-default');
  assert.match(stderr, /\[opencode-lcm\] session\.compacting hook failed/);
});

test('non-throwing store: all four hooks mutate output as expected', async () => {
  const captured = [];
  const store = {
    captureDeferred: async (event) => {
      captured.push(event);
    },
    transformMessages: async (messages) => {
      messages.push({ id: 'archived' });
    },
    systemHint: () => 'SYSTEM_HINT',
    buildCompactionContext: async () => 'COMPACTION_NOTE',
  };
  const hooks = createStoreHooks(store);

  const stderr = await withCapturedStderr(async () => {
    await hooks.event({ event: { type: 'e1' } });

    const msgOut = { messages: [] };
    await hooks['experimental.chat.messages.transform']({}, msgOut);
    assert.equal(msgOut.messages.length, 1);

    const sysOut = { system: [] };
    await hooks['experimental.chat.system.transform']({}, sysOut);
    assert.deepEqual(sysOut.system, ['SYSTEM_HINT']);

    const compOut = { context: [] };
    await hooks['experimental.session.compacting']({ sessionID: 's1' }, compOut);
    assert.deepEqual(compOut.context, ['COMPACTION_NOTE']);
  });

  assert.deepEqual(captured, [{ type: 'e1' }]);
  assert.equal(stderr, '');
});
