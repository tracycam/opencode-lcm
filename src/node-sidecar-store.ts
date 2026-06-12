import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

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
  LcmStore,
  LimitInput,
  PinSessionInput,
  RetentionInput,
  SessionIDInput,
} from './lcm-store.js';
import { buildChildEnv, nodeExecutable, resolveMaxMessageBytes } from './node-sidecar-env.js';
import type { ConversationMessage, OpencodeLcmOptions, SearchResult, StoreStats } from './types.js';

// Cap on consecutive automatic respawns (without an intervening successful
// request) before the store fails fast instead of looping on a dead sidecar.
const MAX_SIDECAR_RESTARTS = 3;

type SidecarResponse =
  | { id: number; result: unknown }
  | { id: number; error: { name?: string; message: string; stack?: string } };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type TransformResult = {
  changed: boolean;
  messages: ConversationMessage[];
};

type Refable = {
  ref?: () => unknown;
  unref?: () => unknown;
};

function formatSidecarError(error: { name?: string; message: string; stack?: string }): Error {
  const wrapped = new Error(error.message);
  wrapped.name = error.name ?? 'NodeSidecarError';
  if (error.stack) wrapped.stack = error.stack;
  return wrapped;
}

export { buildChildEnv, nodeExecutable } from './node-sidecar-env.js';

function localSystemHint(options: OpencodeLcmOptions): string | undefined {
  if (!options.systemHint) return undefined;

  return [
    'Archived session state may exist outside the active prompt.',
    'opencode-lcm may automatically recall archived context when it looks relevant to the current turn.',
    'Use lcm_describe, lcm_grep, lcm_resume, lcm_expand, or lcm_artifact only when deeper archive inspection is still needed.',
    'Keep ctx_* usage selective and treat those calls as infrastructure, not task intent.',
  ].join(' ');
}

export class NodeSidecarLcmStore implements LcmStore {
  private child?: ChildProcessWithoutNullStreams;
  private nextID = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  // Whether init() ever succeeded; gates automatic init replay after a respawn.
  private initialized = false;
  // Whether the CURRENT child process has an initialized store.
  private childInitialized = false;
  // Consecutive respawns since the last successful request (crash-loop guard).
  private restartCount = 0;
  // stderr captured from the most recent crash, surfaced in fail-fast errors.
  private lastStderr = '';
  private readonly maxMessageBytes = resolveMaxMessageBytes();

  constructor(
    private readonly projectDir: string,
    private readonly options: OpencodeLcmOptions,
  ) {}

  async init(): Promise<void> {
    this.ensureStarted();
    await this.send('init', {
      projectDir: this.projectDir,
      options: this.options,
    });
    this.childInitialized = true;
    this.initialized = true;
  }

  close(): void {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;

    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ id: this.nextID++, method: 'close' })}\n`);
    }
    child.kill();
  }

  async captureDeferred(event: Event): Promise<void> {
    await this.request('captureDeferred', event);
  }

  async stats(): Promise<StoreStats> {
    return (await this.request('stats', undefined)) as StoreStats;
  }

  async automaticRetrievalDebug(sessionID?: string): Promise<string> {
    return (await this.request('automaticRetrievalDebug', sessionID)) as string;
  }

  async resume(sessionID?: string): Promise<string> {
    return (await this.request('resume', sessionID)) as string;
  }

  async grep(input: GrepInput): Promise<SearchResult[]> {
    return (await this.request('grep', input)) as SearchResult[];
  }

  async describe(input?: DescribeInput): Promise<string> {
    return (await this.request('describe', input)) as string;
  }

  async lineage(sessionID?: string): Promise<string> {
    return (await this.request('lineage', sessionID)) as string;
  }

  async pinSession(input: PinSessionInput): Promise<string> {
    return (await this.request('pinSession', input)) as string;
  }

  async unpinSession(input: SessionIDInput): Promise<string> {
    return (await this.request('unpinSession', input)) as string;
  }

  async expand(input: ExpandInput): Promise<string> {
    return (await this.request('expand', input)) as string;
  }

  async artifact(input: ArtifactInput): Promise<string> {
    return (await this.request('artifact', input)) as string;
  }

  async blobStats(input: LimitInput): Promise<string> {
    return (await this.request('blobStats', input)) as string;
  }

  async gcBlobs(input: ApplyLimitInput): Promise<string> {
    return (await this.request('gcBlobs', input)) as string;
  }

  async doctor(input?: DoctorInput): Promise<string> {
    return (await this.request('doctor', input)) as string;
  }

  async retentionReport(input?: RetentionInput): Promise<string> {
    return (await this.request('retentionReport', input)) as string;
  }

  async retentionPrune(input: RetentionInput): Promise<string> {
    return (await this.request('retentionPrune', input)) as string;
  }

  async exportSnapshot(input: ExportSnapshotInput): Promise<string> {
    return (await this.request('exportSnapshot', input)) as string;
  }

  async importSnapshot(input: ImportSnapshotInput): Promise<string> {
    return (await this.request('importSnapshot', input)) as string;
  }

  async transformMessages(messages: ConversationMessage[]): Promise<boolean> {
    const result = (await this.request('transformMessages', messages)) as TransformResult;
    messages.splice(0, messages.length, ...result.messages);
    return result.changed;
  }

  async buildCompactionContext(sessionID: string): Promise<string | undefined> {
    return (await this.request('buildCompactionContext', sessionID)) as string | undefined;
  }

  systemHint(): string | undefined {
    return localSystemHint(this.options);
  }

  private ensureStarted(): void {
    if (this.child) return;
    const scriptPath = fileURLToPath(new URL('./node-sidecar.js', import.meta.url));
    const child = spawn(nodeExecutable(), ['--no-warnings', scriptPath], {
      env: buildChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    });
    child.once('error', (error) => this.teardownChild(error, false));
    child.once('exit', (code, signal) => {
      const suffix = this.stderrBuffer ? `\nSidecar stderr:\n${this.stderrBuffer}` : '';
      this.teardownChild(
        new Error(`opencode-lcm Node sidecar exited code=${code} signal=${signal}${suffix}`),
        false,
      );
    });
    this.updateRefs();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureReady();
    const result = await this.send(method, params);
    // A completed request proves the sidecar is healthy again.
    this.restartCount = 0;
    return result;
  }

  // Ensure a live, store-initialized child exists before dispatching a request.
  // Respawns a crashed sidecar (bounded by MAX_SIDECAR_RESTARTS) and replays the
  // init request so the fresh process has a store. Replay failures propagate.
  private async ensureReady(): Promise<void> {
    if (!this.child) {
      if (this.restartCount >= MAX_SIDECAR_RESTARTS) {
        const suffix = this.lastStderr ? `\nLast sidecar stderr:\n${this.lastStderr}` : '';
        throw new Error(
          `opencode-lcm Node sidecar exceeded ${MAX_SIDECAR_RESTARTS} consecutive restart attempts; refusing to respawn.${suffix}`,
        );
      }
      this.restartCount += 1;
      this.ensureStarted();
    }
    if (this.initialized && !this.childInitialized) {
      await this.send('init', {
        projectDir: this.projectDir,
        options: this.options,
      });
      this.childInitialized = true;
    }
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) {
      return Promise.reject(new Error('opencode-lcm Node sidecar is not writable'));
    }

    const id = this.nextID;
    this.nextID += 1;

    const message = `${JSON.stringify({ id, method, params })}\n`;
    const byteLength = Buffer.byteLength(message);
    if (byteLength > this.maxMessageBytes) {
      return Promise.reject(
        new Error(
          `opencode-lcm sidecar request '${method}' is ${byteLength} bytes, exceeding the ${this.maxMessageBytes}-byte message limit`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.updateRefs();
      child.stdin.write(message, (error) => {
        if (!error) return;
        this.pending.delete(id);
        this.updateRefs();
        reject(error);
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (
      this.stdoutBuffer.indexOf('\n') === -1 &&
      Buffer.byteLength(this.stdoutBuffer) > this.maxMessageBytes
    ) {
      // Fatal protocol error: a single response line exceeded the cap without a
      // newline. Tear the child down so the recovery path respawns it lazily.
      this.teardownChild(
        new Error(
          `opencode-lcm sidecar response exceeded the ${this.maxMessageBytes}-byte message limit without a newline`,
        ),
        true,
      );
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      let response: SidecarResponse;
      try {
        response = JSON.parse(line) as SidecarResponse;
      } catch (error) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      this.updateRefs();

      if ('error' in response) pending.reject(formatSidecarError(response.error));
      else pending.resolve(response.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.updateRefs();
  }

  // Reject all pending requests and, unless the store is closed, drop the child
  // reference so the next request lazily respawns it. `kill` is set when we are
  // proactively killing a still-running child (e.g. on a protocol violation).
  private teardownChild(error: Error, kill: boolean): void {
    const child = this.child;
    if (this.stderrBuffer) this.lastStderr = this.stderrBuffer;
    this.rejectAll(error);
    if (this.closed) return;
    this.child = undefined;
    this.childInitialized = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    if (kill) child?.kill();
  }

  private updateRefs(): void {
    const child = this.child;
    if (!child) return;
    const method = this.pending.size > 0 ? 'ref' : 'unref';
    child[method]();
    this.setStreamRef(child.stdin, method);
    this.setStreamRef(child.stdout, method);
    this.setStreamRef(child.stderr, method);
  }

  private setStreamRef(stream: unknown, method: 'ref' | 'unref'): void {
    const refable = stream as Refable;
    refable[method]?.();
  }

  async waitForExitForTests(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await once(child, 'exit');
  }

  getChildPidForTests(): number | undefined {
    return this.child?.pid;
  }

  killChildForTests(): void {
    this.child?.kill('SIGKILL');
  }
}
