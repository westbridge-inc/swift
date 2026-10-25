import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [PERF #8] Inline requires: a module's code runs when something first uses
// it, not all at launch. The danger is a module whose import does something
// the OS needs at launch whatever screen opens: registering the background
// location task (the OS may start the app headless for it) or the
// notification handler. Those are imported for their effect in index.js,
// which inlining never defers, and a census keeps any new one from hiding.
// ---------------------------------------------------------------------------

const MOBILE = join(__dirname, '..', '..');
const index = readFileSync(join(MOBILE, 'index.js'), 'utf8');

/** The import lines of index.js, in order. */
const indexImports = index.split('\n').filter((line) => line.startsWith('import '));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A launch-time OS registration made by a module's top level (column 0). */
const OS_REGISTRATION = /^(?:TaskManager\??\.defineTask|Notifications\.setNotificationHandler|Notifications\.registerTaskAsync|TaskManager\??\.registerTaskAsync|AppRegistry\.registerHeadlessTask|messaging\(\)\.setBackgroundMessageHandler)\(/m;

describe('[PERF #8] inline requires', () => {
  it('the bundle is built with inline requires, keeping Expo’s import support', async () => {
    const config = createRequire(join(MOBILE, 'package.json'))('./metro.config.js');
    const options = await config.transformer.getTransformOptions([], { dev: false, hot: false, platform: 'ios' }, async () => []);
    expect(options.transform).toMatchObject({ inlineRequires: true, experimentalImportSupport: true });
  });

  it('every module that registers with the OS at launch is imported for its effect in index.js, after App', () => {
    const registering = sources(join(MOBILE, 'src'))
      .filter((file) => OS_REGISTRATION.test(readFileSync(file, 'utf8')))
      .map((file) => `./${relative(MOBILE, file).replace(/\.(ts|tsx)$/, '')}`)
      .sort();
    // The two there are today; a new one must be added to index.js too.
    expect(registering).toEqual(['./src/services/backgroundLocation', './src/services/push']);
    const appAt = indexImports.indexOf("import App from './src/App';");
    expect(appAt).toBeGreaterThanOrEqual(0);
    for (const module of registering) {
      const at = indexImports.indexOf(`import '${module}';`);
      expect(at, `${module} is not imported for its effect in index.js`).toBeGreaterThan(appAt);
    }
  });
});
