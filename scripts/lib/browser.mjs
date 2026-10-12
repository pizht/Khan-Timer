/**
 * Locate the Microsoft Edge binary for the live-site verification scripts.
 *
 * The three end-to-end scripts (`verify-extension.mjs`,
 * `verify-practice-switch.mjs`, `verify-startcard-flash.mjs`) used to hard-code
 * the macOS install path, which pinned every real-browser check to one machine
 * and made it impossible to run them from CI. Resolution order is now:
 *
 *   1. `EDGE_PATH` — an explicit executable, wins over everything (this is how
 *      CI and non-default installs point at their browser);
 *   2. the documented default locations for the current platform;
 *   3. `microsoft-edge` / `msedge` on `PATH`.
 *
 * Nothing is resolved at import time: a missing browser is reported by
 * `assertBrowserRunnable()` when a script actually starts its run, not as a
 * module-load error.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Executable names that may sit on `PATH`, per platform. */
const PATH_NAMES = ['microsoft-edge', 'microsoft-edge-stable', 'msedge'];

/** Documented install locations, per platform. */
const DEFAULT_CANDIDATES = {
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
  ],
  linux: [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

/** `true` when `file` exists and is executable. */
export function isRunnable(file) {
  if (typeof file !== 'string' || file === '') return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probe `PATH` for a known Edge executable. Returns the first hit, or `null`. */
function searchPath() {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  for (const name of PATH_NAMES) {
    const probe = spawnSync(locator, [name], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout) continue;
    for (const line of probe.stdout.split(/\r?\n/)) {
      const hit = line.trim();
      if (hit && isRunnable(hit)) return hit;
    }
  }
  return null;
}

/**
 * Resolve the Edge executable, or throw with every path that was tried.
 *
 * Failing here is much better than failing in `spawn`: a missing or
 * non-executable browser otherwise shows up as an unrelated DevTools connection
 * timeout several seconds into the run.
 */
export function resolveEdge() {
  const explicit = process.env.EDGE_PATH?.trim();
  if (explicit) {
    if (!isRunnable(explicit)) {
      throw new Error(
        `EDGE_PATH is set to ${explicit}, but that file is missing or not executable.`,
      );
    }
    return explicit;
  }

  const defaults = DEFAULT_CANDIDATES[process.platform] ?? [];
  for (const candidate of defaults) {
    if (isRunnable(candidate)) return candidate;
  }

  const onPath = searchPath();
  if (onPath) return onPath;

  const tried = [
    ...defaults.map((candidate) => `  - ${candidate}`),
    ...PATH_NAMES.map((name) => `  - ${name} (on PATH)`),
  ].join('\n');
  throw new Error(
    'Microsoft Edge was not found.\n' +
      'These were tried:\n' +
      `${tried}\n` +
      'Set EDGE_PATH to the browser executable and run again, e.g.\n' +
      '  EDGE_PATH="/path/to/msedge" pnpm run verify:edge',
  );
}

/**
 * Fail fast, before any profile is created or DevTools port is opened, when no
 * usable browser can be found.
 */
export function assertBrowserRunnable() {
  resolveEdge();
}
