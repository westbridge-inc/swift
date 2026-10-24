import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [AUD-1 row 303] The web and admin deploy workflows hold the Vercel deploy
// token. They ran `npx vercel`: whatever version the registry called latest at
// deploy time, fetched and run (install scripts included) in the step that had
// the token, which was also passed on the command line. And the dependency
// audit read pnpm-lock.yaml only, never the desktop app's Cargo.lock.
// These tests read the real workflow files.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const read = (name: string) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');

/** Each `- ` step of a workflow's steps list, as its own text block. */
function steps(workflow: string): string[] {
  return workflow.split(/\n(?= {6}- )/).slice(1);
}

describe.each([
  ['deploy-web.yml', 'apps/web'],
  ['deploy-admin.yml', 'apps/admin'],
])('%s holds the deploy token, so its tool is pinned and the token stays out of argv', (file, app) => {
  const workflow = read(file);
  const all = steps(workflow);
  const install = all.find((s) => s.includes('name: Install the Vercel CLI'));
  const deploy = all.find((s) => s.includes('name: Deploy to Vercel'));

  it('installs the Vercel CLI at an exact version, install scripts off, in a step without the token', () => {
    expect(install).toBeDefined();
    expect(install).toMatch(/npm install --prefix "\$RUNNER_TEMP\/vercel-cli" --no-save --ignore-scripts vercel@\d+\.\d+\.\d+\n/);
    expect(install).not.toMatch(/secrets\.|VERCEL_TOKEN/);
    expect(all.indexOf(install!)).toBeLessThan(all.indexOf(deploy!));
  });

  it('deploys with that installed binary, never a registry fetch, and the token only in the environment', () => {
    expect(deploy).toBeDefined();
    expect(deploy).toContain('"$RUNNER_TEMP/vercel-cli/node_modules/.bin/vercel" --prod');
    expect(deploy).toContain(`working-directory: ${app}`);
    expect(deploy).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(workflow).not.toMatch(/\bnpx\b|npm exec|pnpm dlx|yarn dlx/);
    expect(workflow).not.toMatch(/--token/);
    // No expression is spliced into a shell line: values reach the script through env.
    const runLines = deploy!.split('\n').filter((l) => !/^\s+[A-Z_]+: \$\{\{/.test(l));
    expect(runLines.join('\n')).not.toContain('${{');
  });

  it('only the deploy step sees a secret; the token never reaches install or build steps', () => {
    for (const step of all) {
      if (step === deploy) continue;
      expect(step, step.split('\n')[0]).not.toMatch(/secrets\./);
    }
  });

  it('least privilege: read-only contents, and the checkout keeps no repository token on disk', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/:\s*write\b/);
    const checkout = all.find((s) => s.includes('uses: actions/checkout@'));
    expect(checkout).toContain('persist-credentials: false');
  });
});

describe('the dependency audit reads the desktop app\'s Cargo.lock too', () => {
  const ci = read('ci.yml');
  const start = ci.indexOf('name: Security Scan');
  const rest = ci.slice(start);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next);

  it('scans apps/desktop/src-tauri/Cargo.lock at HIGH+ with a blocking exit code and the scoped ignore file', () => {
    const scan = job.split('\n').find((l) => l.includes('trivy fs') && l.includes('Cargo.lock')) ?? '';
    expect(scan).toContain('--scanners vuln');
    expect(scan).toContain('--severity HIGH,CRITICAL');
    expect(scan).toContain('--exit-code 1');
    expect(scan).toContain('--ignorefile .trivyignore.yaml');
    expect(scan.trim().endsWith('apps/desktop/src-tauri/Cargo.lock')).toBe(true);
    expect(readFileSync(join(REPO, 'apps', 'desktop', 'src-tauri', 'Cargo.lock'), 'utf8')).toContain('[[package]]');
  });
});
