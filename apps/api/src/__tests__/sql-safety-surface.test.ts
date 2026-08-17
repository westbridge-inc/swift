import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : productionTypeScriptFiles(target);
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [target]
      : [];
  });
}

describe('production SQL safety surface', () => {
  it('does not use Prisma unsafe raw-query APIs or raw identifier fragments', () => {
    const sourceRoot = path.resolve(__dirname, '..');
    const seed = path.resolve(__dirname, '../../prisma/seed-platform.ts');
    const offenders = [...productionTypeScriptFiles(sourceRoot), seed].flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return /\$(?:queryRawUnsafe|executeRawUnsafe)|Prisma\.raw\s*\(/.test(source)
        ? [path.relative(path.dirname(sourceRoot), file)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
