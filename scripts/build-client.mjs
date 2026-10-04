// Generator: src/client/index.jsx → lib/client.js (bundle artifact shipped
// with the plugin). Wraps the esbuild CJS output in the official
// __ModuleLoader__.load contract; 'react' and primitives stay external.
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'lib', 'client.js');
const PLUGIN_ID = 'dsh-flp-studio';

export function generate({ check = false } = {}) {
  const result = buildSync({
    entryPoints: [resolve(ROOT, 'src', 'client', 'index.jsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    write: false,
    logLevel: 'silent',
  });
  const body = result.outputFiles[0].text.replace(/\n$/, '');
  const code = 'window.__ModuleLoader__.load({\n'
    + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
    + '\tfactory: (require) => {\n'
    + '\t\tvar module = { exports: {} };\n'
    + '\t\tvar exports = module.exports;\n'
    + body
    + '\n\t\treturn module.exports;\n'
    + '\t}\n'
    + '});\n';
  if (check) {
    const committed = readFileSync(OUTPUT, 'utf8');
    if (committed !== code) {
      console.error('[build-client] lib/client.js is stale — run: node scripts/build-client.mjs');
      process.exit(1);
    }
    console.log('[build-client] lib/client.js is fresh (--check OK)');
    return;
  }
  writeFileSync(OUTPUT, code);
  console.log('[build-client] lib/client.js generated (' + code.length + ' bytes)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generate({ check: process.argv.includes('--check') });
}
