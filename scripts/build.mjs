#!/usr/bin/env node
/**
 * Build the loadable Edge extension into `dist/`.
 *
 * Source and build output are kept strictly separate (spec 5.2): Edge loads
 * only the compiled JavaScript and the Manifest V3 files from `dist/`.
 *
 * Deliberate choice: the bundle is NOT minified, and an external source map is
 * emitted alongside it. Spec 8.4 requires a code review to confirm that no
 * timing data is uploaded anywhere; unminified, mapped output makes that
 * review straightforward.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

const watch = process.argv.includes('--watch');

/**
 * Two bundles, both IIFE:
 *  - content.js runs in the page's isolated content-script world,
 *  - popup.js runs in the extension page.
 * IIFE avoids any module-loading concerns under the extension CSP.
 */
const entryPoints = [
  { in: path.join(SRC, 'content.ts'), out: path.join(DIST, 'content') },
  { in: path.join(SRC, 'popup.ts'), out: path.join(DIST, 'popup') },
];

const common = {
  bundle: true,
  format: 'iife',
  // Edge 154 is the verified target; this keeps output modern but safe.
  target: ['chrome114'],
  platform: 'browser',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

async function copyStatic() {
  await mkdir(DIST, { recursive: true });
  await cp(PUBLIC, DIST, { recursive: true });
}

/** Keep the manifest's declared version in sync with package.json. */
async function syncVersion() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifestPath = path.join(DIST, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

async function main() {
  if (!watch) {
    await rm(DIST, { recursive: true, force: true });
  }
  await copyStatic();
  await syncVersion();

  if (watch) {
    const contexts = await Promise.all(
      entryPoints.map(({ in: input, out }) =>
        context({ ...common, entryPoints: [input], outfile: `${out}.js` }),
      ),
    );
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('[build] watching for changes…');
    return;
  }

  await Promise.all(
    entryPoints.map(({ in: input, out }) =>
      build({ ...common, entryPoints: [input], outfile: `${out}.js` }),
    ),
  );
  console.log(`[build] dist/ ready at ${DIST}`);
}

main().catch((error) => {
  console.error('[build] failed:', error);
  process.exit(1);
});
