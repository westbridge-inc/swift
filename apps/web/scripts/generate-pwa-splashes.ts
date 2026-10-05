/** Run from apps/web: node --import tsx scripts/generate-pwa-splashes.ts.
 *  Compose the existing icon unchanged on the app's own launch background. */
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { color } from '../../../packages/ui/src/tokens';
import { iphoneScreens } from '../src/lib/apple-startup-images';

const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

async function generate() {
  await mkdir(`${publicDir}/splash`, { recursive: true });
  for (const [width, height, ratio] of iphoneScreens) {
    const icon = await sharp(`${publicDir}/icons/icon-512.png`).resize(96 * ratio).toBuffer();
    for (const orientation of ['portrait', 'landscape']) {
      await sharp({ create: {
        width: (orientation === 'portrait' ? width : height) * ratio,
        height: (orientation === 'portrait' ? height : width) * ratio,
        channels: 3, background: color.surface.subtle,
      } }).composite([{ input: icon, gravity: 'centre' }]).removeAlpha().png({ compressionLevel: 9 })
        .toFile(`${publicDir}/splash/iphone-${width}-${height}-${ratio}-${orientation}.png`);
    }
  }
  console.log(`Generated ${iphoneScreens.length * 2} iPhone splash images.`);
}
void generate();
