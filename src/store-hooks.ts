import type { Hooks } from '@opencode-ai/plugin';

import type { LcmStore } from './lcm-store.js';

// NOTE: This module exists so that createStoreHooks is NOT exported from the plugin
// entry module (index.ts). OpenCode's plugin loader invokes every function exported
// by the entry module as a plugin factory; exporting createStoreHooks there caused
// the loader to call it with a PluginInput as the `store` argument, producing hooks
// bound to a non-store that failed on every event with
// "store.captureDeferred is not a function".
export type StoreHooks = Pick<
  Hooks,
  | 'event'
  | 'experimental.chat.messages.transform'
  | 'experimental.chat.system.transform'
  | 'experimental.session.compacting'
>;

function logHookError(hookName: string, error: unknown): void {
  process.stderr.write(
    `[opencode-lcm] ${hookName}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

export function createStoreHooks(store: LcmStore): StoreHooks {
  return {
    event: async ({ event }) => {
      try {
        await store.captureDeferred(event);
      } catch (error) {
        logHookError('event hook failed (captureDeferred)', error);
      }
    },

    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        await store.transformMessages(output.messages);
      } catch (error) {
        logHookError('messages.transform hook failed', error);
      }
    },

    'experimental.chat.system.transform': async (_input, output) => {
      try {
        const hint = store.systemHint();
        if (!hint) return;
        output.system.push(hint);
      } catch (error) {
        logHookError('system.transform hook failed', error);
      }
    },

    'experimental.session.compacting': async (input, output) => {
      try {
        const note = await store.buildCompactionContext(input.sessionID);
        if (!note) return;
        if (output.context.some((entry) => entry.includes('LCM prototype resume note'))) return;
        output.context.push(note);
      } catch (error) {
        logHookError('session.compacting hook failed', error);
      }
    },
  };
}
