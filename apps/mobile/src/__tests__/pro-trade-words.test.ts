import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// [BUG-HUNT F24] A pro's own screen headed itself with the trade's code. The server sends the words beside it.
describe('the pro\'s screen', () => {
  it('heads itself with the server\'s words for the trade', () => {
    const screen = readFileSync(join(__dirname, '..', 'modules', 'services', 'screens', 'ServiceProviderScreen.tsx'), 'utf8');
    expect(screen).toContain('{provider.tradeLabel ?? provider.trade}');
    expect(screen).not.toContain('<T variant="heading">{provider.trade}</T>');
  });
});
