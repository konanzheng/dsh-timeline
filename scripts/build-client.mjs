#!/usr/bin/env node
/**
 * Build the DSH client bundle in the exact format the DSH client module
 * loader expects:
 *
 *   window.__ModuleLoader__.load({
 *     id: 'dsh-history',
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
 *       ...bundled body...
 *       exports.apply = DSH_HISTORY.apply;
 *       exports.inject = DSH_HISTORY.inject;
 *       return module.exports;
 *     }
 *   });
 *
 * The browser body is built by esbuild as an IIFE under the global
 * `DSH_HISTORY` (CSS inlined via `.css=text`). The banner/footer wrap that
 * IIFE in the loader call and wire the exports the loader reads (`apply`,
 * `inject`). The host half (`lib/index.js`) is a plain ESM build of the empty
 * node `apply()`.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../lib/client.js')
const hostOut = resolve(here, '../lib/index.js')

// Host-side (node) entry — the DSH plugin loader imports `lib/index.js`
// (per package.json `main` / `exports["."]`).
await build({
  entryPoints: [resolve(here, '../src/index.ts')],
  bundle: true,
  format: 'esm',
  outfile: hostOut,
  platform: 'node',
  legalComments: 'none',
  logLevel: 'info',
})

const banner = `window.__ModuleLoader__.load({
	id: 'dsh-history',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
`

const footer = `
		exports.apply = DSH_HISTORY.apply;
		exports.inject = DSH_HISTORY.inject;
		return module.exports;
	}
});
`

await build({
  entryPoints: [resolve(here, '../src/client/plugin.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'DSH_HISTORY',
  banner: { js: banner },
  footer: { js: footer },
  outfile: out,
  loader: { '.css': 'text' },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})

console.log(`\n[dsh-history] client bundle written to ${out}`)
