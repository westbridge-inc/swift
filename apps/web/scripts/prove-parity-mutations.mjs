// Run from apps/web with node 20. No services or extra dependencies.
// Temporarily mutate one owned source file, run the relevant behavioral test,
// and restore its exact bytes in finally. Do not run alongside builds/tests.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const cases = [
  {
    name: 'mixed-store grouping', file: 'src/lib/cart-presentation.ts',
    from: 'const id = item.vendorId || null;', to: "const id = 'one-store';",
    test: 'src/app/(app)/cart/store-groups.test.tsx', match: 'groups the screenshot items',
  },
  {
    name: 'plain-language census', file: 'src/app/(app)/cart/page.tsx',
    from: 'Checking your items with the store…', to: 'Checking saved lines against the server quote…',
    test: 'src/lib/cart-copy.test.ts', match: 'has no technical customer strings',
  },
  {
    name: 'bicycle checklist request', file: 'src/lib/verification.ts',
    from: "params.set('vehicleType', vehicleType);", to: "params.set('vehicleType', 'CAR');",
    test: 'src/components/partner-parity.test.tsx', match: 'requests the canonical MOVER / BICYCLE',
  },
  {
    name: 'company address rendering', file: 'src/components/app-details.tsx',
    from: '{site.address}', to: 'Address unavailable',
    test: 'src/components/partner-parity.test.tsx', match: 'renders company, contact',
  },
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const config = existsSync('vitest.comb.config.ts') ? 'vitest.comb.config.ts' : 'vitest.parity.config.ts';
function run(test, match) {
  const args = ['run', '--config', config, '--maxWorkers=2', test, '-t', match];
  console.log(`./node_modules/.bin/vitest ${args.join(' ')}`);
  const result = spawnSync('./node_modules/.bin/vitest', args, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DEBUG_PRINT_LIMIT: '300' } });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  console.log(output.split('\n').filter((line) => /Test Files|Tests |FAIL |Error:/.test(line)).join('\n'));
  if (result.error || result.signal) throw result.error ?? new Error(`Test interrupted: ${result.signal}`);
  return result.status;
}
for (const mutation of cases) {
  const original = readFileSync(mutation.file);
  const source = original.toString();
  if (!source.includes(mutation.from)) throw new Error(`Missing mutation target: ${mutation.name}`);
  if (run(mutation.test, mutation.match) !== 0) throw new Error(`Baseline failed: ${mutation.name}`);
  try {
    writeFileSync(mutation.file, source.replace(mutation.from, mutation.to));
    if (run(mutation.test, mutation.match) !== 1) throw new Error(`Mutation survived: ${mutation.name}`);
    console.log(`KILLED: ${mutation.name}`);
  } finally {
    writeFileSync(mutation.file, original);
    if (digest(readFileSync(mutation.file)) !== digest(original)) throw new Error('Restoration failed');
  }
  if (run(mutation.test, mutation.match) !== 0) throw new Error(`Restored test failed: ${mutation.name}`);
  console.log(`RESTORED: ${mutation.name} ${digest(original)}`);
}
