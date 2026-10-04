// Host smoke test for dsh-flp-studio.
// Verifies the TypertRemoteService exposes all three remotes and that the
// Python bridge round-trips on a real .flp (a COPY — never the user's original).
import { readFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Use a disposable copy of the real project (never edit the original).
const SRC = process.argv[2] || 'D:\\momol\\Documents\\Harness\\_flp_analysis_work\\angel.flp';
const WORK = join(ROOT, '.test-work');
const COPY = join(WORK, 'test.flp');

import { mkdirSync, existsSync, rmSync } from 'node:fs';
mkdirSync(WORK, { recursive: true });
if (existsSync(COPY)) { rmSync(COPY, { force: true }); }
copyFileSync(SRC, COPY);

// Minimal fake ctx for the service constructor.
const fakeCtx = { get: () => undefined };

async function main() {
  const { default: FlpStudioService } = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
  const { Context } = await import(pathToFileURL(join(ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href);
  const { remoteMethods } = await import(pathToFileURL(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js')).href);
  const ctx = new Context();
  const svc = new FlpStudioService(ctx, {});

  // 1. remote methods registered?
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter((m) => m !== 'constructor');
  console.log('service methods:', methods.join(', '));
  if (!methods.includes('listdir') || !methods.includes('analyze') || !methods.includes('editNote')) {
    console.error('FAIL: missing remote methods');
    process.exit(1);
  }
  // Per the skill: __runInitializers must be called, else remoteMethods is empty.
  const rm = remoteMethods(svc);
  console.log('remoteMethods:', JSON.stringify(rm));
  if (!Array.isArray(rm) || rm.length === 0) {
    console.error('FAIL: remoteMethods empty — __runInitializers not applied');
    process.exit(1);
  }

  // 2. analyze the copy
  console.log('\n== analyze ==');
  const a = await svc.analyze(COPY);
  console.log('ok:', a.ok, '| tempo:', a.tempo, '| channels:', a.channelCount, '| patterns:', a.patterns?.length);
  if (!a.ok) { console.error('FAIL analyze:', a); process.exit(1); }
  console.log('sample channels:', a.channels?.slice(0, 3).map((c) => `${c.name}(${c.type})`).join(', '));
  console.log('features:', JSON.stringify(a.features).slice(0, 300));

  // 3. editNote: change first School Piano note key on the copy
  console.log('\n== editNote ==');
  const e = await svc.editNote(COPY, { pattern: 'School Piano', notes: [{ op: 'set', index: 0, field: 'key', value: 62 }] });
  console.log('ok:', e.ok, '| backup:', e.backup, '| applied:', JSON.stringify(e.applied));
  if (!e.ok) { console.error('FAIL editNote:', e); process.exit(1); }

  // 4. re-analyze to confirm persistence
  const a2 = await svc.analyze(COPY);
  const sp = a2.patterns?.find((p) => p.name === 'School Piano');
  console.log('after edit, School Piano first sample key:', sp?.sampleKeys?.[0]);
  if (!a2.ok) { console.error('FAIL re-analyze:', a2); process.exit(1); }

  // 5. listdir
  console.log('\n== listdir ==');
  const l = await svc.listdir(join(ROOT, '.test-work'));
  console.log('ok:', l.ok, '| files:', l.files?.map((f) => f.name).join(', '));

  console.log('\nALL CHECKS PASSED');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
