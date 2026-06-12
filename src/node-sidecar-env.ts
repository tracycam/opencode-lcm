import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the Node executable used to spawn the sidecar process.
 *
 * Security: an `OPENCODE_LCM_NODE_PATH` override is honored ONLY when it is an
 * absolute path that exists on disk. A relative or nonexistent override is an
 * arbitrary-code-execution vector (e.g. a `.env` file dropped into a shared dev
 * container or CI workspace), so it is ignored with a warning.
 */
export function nodeExecutable(): string {
  const override = process.env.OPENCODE_LCM_NODE_PATH;
  if (override) {
    if (path.isAbsolute(override) && existsSync(override)) {
      return override;
    }
    process.stderr.write(
      `[opencode-lcm] ignoring invalid OPENCODE_LCM_NODE_PATH (not absolute or does not exist): ${override}\n`,
    );
  }
  return process.env.NODE || 'node';
}

/**
 * Maximum byte length of a single newline-delimited JSON sidecar message.
 *
 * The cap protects both the client (oversized outbound request) and the server
 * (oversized inbound line) from unbounded buffering. It can be lowered for tests
 * via `OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES`. Because the cap must match on both
 * ends of the protocol and that env var starts with `OPENCODE_LCM_`, it is
 * forwarded to the child automatically by `buildChildEnv()`.
 */
export const MAX_SIDECAR_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the per-message byte cap, honoring a positive-integer
 * `OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES` override. Invalid overrides (not a
 * positive integer) are ignored with a warning and the default is used.
 */
export function resolveMaxMessageBytes(): number {
  const override = process.env.OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    process.stderr.write(
      `[opencode-lcm] ignoring invalid OPENCODE_LCM_SIDECAR_MAX_MESSAGE_BYTES (not a positive integer): ${override}\n`,
    );
  }
  return MAX_SIDECAR_MESSAGE_BYTES;
}

/**
 * Environment variables that are safe to forward to the sidecar child process.
 * Includes cross-platform locale, temp, and home directory keys for both Unix
 * (TMPDIR, HOME) and Windows (TEMP/TMP, SystemRoot, USERPROFILE, WINDIR).
 */
export const WHITELISTED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE',
];

/**
 * Build the environment for the sidecar child process.
 *
 * Security: the parent's full `process.env` is NOT forwarded. Only an explicit
 * whitelist plus `OPENCODE_LCM_*` configuration is passed, preventing secrets
 * (AWS keys, SSH tokens, DB passwords, etc.) from leaking into the child. The
 * `NODE_OPTIONS` injection vector is always stripped, and `OPENCODE_LCM_NODE_PATH`
 * is never forwarded so it cannot be re-evaluated unsafely downstream.
 */
export function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WHITELISTED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Every OPENCODE_LCM_* var except unsafe overrides
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('OPENCODE_LCM_') && key !== 'OPENCODE_LCM_NODE_PATH') {
      env[key] = value;
    }
  }
  // CRITICAL: never pass NODE_OPTIONS (injection vector via --require etc.)
  delete env.NODE_OPTIONS;
  // Force SQLite runtime
  env.OPENCODE_LCM_SQLITE_RUNTIME = 'node';
  return env;
}
