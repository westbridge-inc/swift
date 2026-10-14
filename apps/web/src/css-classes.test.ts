import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Swift's shared classes (sw-btn, sw-card, sw-title, ...) live in the app's
// global stylesheet. A class name that is not defined there does nothing: a
// button given one renders as bare text (the "Done" in the delivery-or-pickup
// sheet and the guest basket's buttons were like that on staging).
const SRC = join(process.cwd(), 'src');
function filesUnder(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, found); else found.push(path);
  }
  return found;
}
const files = filesUnder(SRC);
const defined = new Set(files
  .filter((file) => file.endsWith('.css') && !file.endsWith('.module.css'))
  .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/\.(sw-[a-z0-9-]+)/g)].map((match) => match[1]!)));
const sources = files.filter((file) => /\.(tsx?|jsx?)$/.test(file) && !/\.test\.|\.d\.ts$/.test(file) && !file.includes(`${join('src', 'test')}/`));

describe('Swift classes', () => {
  it('every sw- class the web app uses is defined in its global stylesheet', () => {
    expect(defined.has('sw-btn')).toBe(true);
    const undefinedClasses = sources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?<![\w-])(sw-[a-z0-9-]+)/g)]
      .map((match) => match[1]!)
      .filter((name) => !defined.has(name))
      .map((name) => `${relative(SRC, file)}: ${name}`));
    expect(undefinedClasses).toEqual([]);
  });
});
