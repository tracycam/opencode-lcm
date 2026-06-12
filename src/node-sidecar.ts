import { createInterface } from 'node:readline';

import type { Event } from '@opencode-ai/sdk';

import type {
  ApplyLimitInput,
  ArtifactInput,
  DescribeInput,
  DoctorInput,
  ExpandInput,
  ExportSnapshotInput,
  GrepInput,
  ImportSnapshotInput,
  LimitInput,
  PinSessionInput,
  RetentionInput,
  SessionIDInput,
} from './lcm-store.js';
import { resolveMaxMessageBytes } from './node-sidecar-env.js';
import { SqliteLcmStore } from './store.js';
import type { ConversationMessage, OpencodeLcmOptions } from './types.js';

type RequestMessage = {
  id: number;
  method: string;
  params?: unknown;
};

let store: SqliteLcmStore | undefined;
let chain = Promise.resolve();
const maxMessageBytes = resolveMaxMessageBytes();

function writeResponse(id: number, body: { result: unknown } | { error: unknown }): void {
  process.stdout.write(`${JSON.stringify({ id, ...body })}\n`);
}

function serializeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function requireStore(): SqliteLcmStore {
  if (!store) throw new Error('opencode-lcm sidecar store is not initialized');
  return store;
}

async function handleRequest(request: RequestMessage): Promise<unknown> {
  switch (request.method) {
    case 'init': {
      const params = request.params as { projectDir: string; options: OpencodeLcmOptions };
      store = new SqliteLcmStore(params.projectDir, params.options);
      await store.init();
      return true;
    }
    case 'close':
      store?.close();
      store = undefined;
      process.exitCode = 0;
      return true;
    case 'captureDeferred':
      await requireStore().captureDeferred(request.params as Event);
      return true;
    case 'stats':
      return await requireStore().stats();
    case 'automaticRetrievalDebug':
      return await requireStore().automaticRetrievalDebug(request.params as string | undefined);
    case 'resume':
      return await requireStore().resume(request.params as string | undefined);
    case 'grep':
      return await requireStore().grep(request.params as GrepInput);
    case 'describe':
      return await requireStore().describe(request.params as DescribeInput | undefined);
    case 'lineage':
      return await requireStore().lineage(request.params as string | undefined);
    case 'pinSession':
      return await requireStore().pinSession(request.params as PinSessionInput);
    case 'unpinSession':
      return await requireStore().unpinSession(request.params as SessionIDInput);
    case 'expand':
      return await requireStore().expand(request.params as ExpandInput);
    case 'artifact':
      return await requireStore().artifact(request.params as ArtifactInput);
    case 'blobStats':
      return await requireStore().blobStats(request.params as LimitInput);
    case 'gcBlobs':
      return await requireStore().gcBlobs(request.params as ApplyLimitInput);
    case 'doctor':
      return await requireStore().doctor(request.params as DoctorInput | undefined);
    case 'retentionReport':
      return await requireStore().retentionReport(request.params as RetentionInput | undefined);
    case 'retentionPrune':
      return await requireStore().retentionPrune(request.params as RetentionInput);
    case 'exportSnapshot':
      return await requireStore().exportSnapshot(request.params as ExportSnapshotInput);
    case 'importSnapshot':
      return await requireStore().importSnapshot(request.params as ImportSnapshotInput);
    case 'transformMessages': {
      const messages = request.params as ConversationMessage[];
      const changed = await requireStore().transformMessages(messages);
      return { changed, messages };
    }
    case 'buildCompactionContext':
      return await requireStore().buildCompactionContext(request.params as string);
    default:
      throw new Error(`Unknown opencode-lcm sidecar method: ${request.method}`);
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

async function processLine(line: string): Promise<void> {
  if (Buffer.byteLength(line) > maxMessageBytes) {
    // Defensive guard: the client rejects oversized payloads before sending, so a
    // line over the cap means protocol corruption/abuse. We cannot trust the
    // contents enough to recover an id, so we log to stderr and skip rather than
    // risk wedging the serial chain. Subsequent valid lines are unaffected.
    process.stderr.write(
      `[opencode-lcm sidecar] dropping oversized request line (${Buffer.byteLength(line)} bytes, cap ${maxMessageBytes})\n`,
    );
    return;
  }
  let request: RequestMessage;
  try {
    request = JSON.parse(line) as RequestMessage;
  } catch (error) {
    // A malformed line must never break subsequent requests: log and skip.
    process.stderr.write(
      `[opencode-lcm sidecar] skipping malformed request line: ${serializeError(error).message}\n`,
    );
    return;
  }
  try {
    const result = await handleRequest(request);
    writeResponse(request.id, { result });
  } catch (error) {
    writeResponse(request.id, { error: serializeError(error) });
  }
}

rl.on('line', (line) => {
  // Keep requests serial, but ensure the chain NEVER rejects: a thrown error in
  // one line handler must not short-circuit every subsequent line.
  chain = chain
    .then(() => processLine(line))
    .catch((error) => {
      process.stderr.write(
        `[opencode-lcm sidecar] unexpected line-handler failure: ${serializeError(error).message}\n`,
      );
    });
});

rl.on('close', () => {
  store?.close();
});
