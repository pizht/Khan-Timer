#!/usr/bin/env node
/**
 * Verify that `dist/` is a valid, minimal, privacy-respecting MV3 extension.
 *
 * This turns several acceptance criteria into a machine-checked gate rather
 * than a claim (spec 8.1, 8.4, 6, and the delivery list in 10):
 *
 *   - the manifest parses and is Manifest V3,
 *   - every file the manifest references actually exists,
 *   - permissions are within an explicit allowlist, and none were added
 *     "just in case" (spec 6),
 *   - content scripts are restricted to khanacademy.org origins,
 *   - the shipped JavaScript contains no network APIs, no remote code and no
 *     dynamic code evaluation (spec 3.9, 6, 8.4),
 *   - icons are real PNGs at the declared sizes.
 *
 * Exit code is non-zero if any check fails.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Permissions this project is allowed to declare, with justification. */
const ALLOWED_PERMISSIONS = new Set([
  'storage', // settings + timing records, chrome.storage.local (spec 2.5)
  'activeTab', // popup reads live status from the Khan Academy tab in view
]);

const REQUIRED_FILES = [
  'manifest.json',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

/** Patterns that would indicate network access or remote/dynamic code. */
const FORBIDDEN_PATTERNS = [
  { name: 'fetch()', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'EventSource', re: /\bEventSource\b/ },
  { name: 'sendBeacon', re: /\bsendBeacon\b/ },
  { name: 'eval()', re: /\beval\s*\(/ },
  { name: 'new Function', re: /\bnew\s+Function\s*\(/ },
  { name: 'importScripts', re: /\bimportScripts\s*\(/ },
  { name: 'remote script injection', re: /document\.createElement\(\s*['"]script['"]\s*\)/ },
  { name: 'absolute http(s) URL', re: /https?:\/\/(?!www\.khanacademy\.org)/ },
];

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Minimal PNG header check: signature + IHDR width/height. */
function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
  // 1. Required files exist.
  for (const rel of REQUIRED_FILES) {
    check(`dist/${rel} exists`, await exists(path.join(DIST, rel)));
  }

  if (!(await exists(path.join(DIST, 'manifest.json')))) {
    report();
    return;
  }

  // 2. Manifest shape.
  const manifestRaw = await readFile(path.join(DIST, 'manifest.json'), 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
    check('manifest.json parses', true);
  } catch (error) {
    check('manifest.json parses', false, error.message);
    report();
    return;
  }

  check('manifest_version is 3', manifest.manifest_version === 3, `got ${manifest.manifest_version}`);
  check('name present', typeof manifest.name === 'string' && manifest.name.length > 0);
  check(
    'version is dotted numeric',
    typeof manifest.version === 'string' && /^\d+(\.\d+){0,3}$/.test(manifest.version),
    `got ${manifest.version}`,
  );
  check('description present', typeof manifest.description === 'string');

  // 3. Permissions are minimal and declared.
  const permissions = manifest.permissions ?? [];
  const extra = permissions.filter((p) => !ALLOWED_PERMISSIONS.has(p));
  check(
    'permissions within allowlist',
    extra.length === 0,
    extra.length ? `unexpected: ${extra.join(', ')}` : `declared: ${permissions.join(', ') || '(none)'}`,
  );
  const hostPermissions = manifest.host_permissions ?? [];
  check(
    'no host_permissions requested',
    hostPermissions.length === 0,
    hostPermissions.join(', '),
  );
  check('no optional_permissions', !manifest.optional_permissions);
  check('no background service worker', !manifest.background, 'not needed: popup + content script only');
  check('no web_accessible_resources', !manifest.web_accessible_resources, 'would widen the attack surface');

  // 4. Content script scope.
  const scripts = manifest.content_scripts ?? [];
  check('exactly one content script entry', scripts.length === 1, `got ${scripts.length}`);
  const matches = scripts[0]?.matches ?? [];
  check(
    'content script limited to khanacademy.org origins',
    // Accepts "https://www.khanacademy.org/*" and "https://*.khanacademy.org/*"
    // but rejects any other host.
    matches.length > 0 &&
      matches.every((m) => /^https:\/\/(\*\.)?([a-z0-9-]+\.)?khanacademy\.org\//.test(m)),
    matches.join(', '),
  );
  check(
    'content script uses no <all_urls>',
    !matches.includes('<all_urls>'),
  );
  const jsFiles = scripts[0]?.js ?? [];
  for (const file of jsFiles) {
    check(`content script file dist/${file} exists`, await exists(path.join(DIST, file)));
  }

  // 5. Every manifest-referenced file exists.
  const referenced = [
    manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...jsFiles,
  ].filter((v) => typeof v === 'string');
  for (const rel of new Set(referenced)) {
    check(`manifest reference dist/${rel} exists`, await exists(path.join(DIST, rel)));
  }

  // 6. Shipped JavaScript: no network, no remote/dynamic code.
  const jsFilesOnDisk = (await readdir(DIST)).filter((f) => f.endsWith('.js'));
  for (const file of jsFilesOnDisk) {
    const source = await readFile(path.join(DIST, file), 'utf8');
    const withoutMaps = source.replace(/\/\/# sourceMappingURL=.*$/gm, '');
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      const match = withoutMaps.match(re);
      check(`dist/${file}: no ${name}`, !match, match ? `found: ${match[0]}` : '');
    }
    check(`dist/${file}: has source map`, /sourceMappingURL=/.test(source));
  }

  // 7. Icons are genuine PNGs at the declared dimensions.
  for (const size of [16, 32, 48, 128]) {
    const rel = `icons/icon${size}.png`;
    const p = path.join(DIST, rel);
    if (!(await exists(p))) continue;
    const dims = pngSize(await readFile(p));
    check(
      `dist/${rel} is a ${size}x${size} PNG`,
      dims !== null && dims.width === size && dims.height === size,
      dims ? `${dims.width}x${dims.height}` : 'not a valid PNG',
    );
  }

  // 8. No stray build artefacts that would ship unnoticed.
  const entries = await readdir(DIST, { recursive: true, withFileTypes: true });
  const unexpected = entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(DIST, path.join(e.parentPath ?? e.path, e.name)))
    .filter((rel) => {
      const allowed =
        REQUIRED_FILES.includes(rel) ||
        rel.endsWith('.js.map') ||
        rel === 'content.js.map' ||
        rel === 'popup.js.map';
      return !allowed;
    });
  check('no unexpected files in dist/', unexpected.length === 0, unexpected.join(', '));

  report();
}

function report() {
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log('\n  dist/ verification\n' + '  ' + '─'.repeat(width + 12));
  for (const r of results) {
    const mark = r.ok ? '\u2713' : '\u2717';
    const detail = r.detail ? `  (${r.detail})` : '';
    console.log(`  ${mark} ${r.name.padEnd(width)}${detail}`);
  }
  console.log('  ' + '─'.repeat(width + 12));
  if (failures === 0) {
    console.log(`  all ${results.length} checks passed\n`);
  } else {
    console.log(`  ${failures} of ${results.length} checks FAILED\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[verify-dist] failed:', error);
  process.exit(1);
});
