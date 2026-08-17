import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const banner = readFileSync(join(process.cwd(), 'src/components/OfflineBanner.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
const appConfig = readFileSync(join(process.cwd(), 'app.config.ts'), 'utf8');

describe('connectivity boundary contract', () => {
  it('confirms stale false samples and refreshes when the app returns foreground', () => {
    expect(banner).toContain('OFFLINE_CONFIRMATION_MS');
    expect(banner).toContain('void netInfo.refresh()');
    expect(banner).toContain("AppState.addEventListener('change'");
    expect(banner).toContain("state !== 'active'");
    expect(banner).toContain('onlineManager.setOnline(connected)');
  });

  it('reserves measured banner body space instead of covering navigation headers', () => {
    expect(app).toContain('<ConnectivityBoundary>');
    expect(app).toContain('<RootNavigator />');
    expect(banner).toContain('paddingTop: offline ? bannerBodyHeight : 0');
    expect(banner).toContain('offlineBannerBodyHeight(event.nativeEvent.layout.height, insets.top)');
    expect(banner).toContain('pointerEvents="none"');
  });

  it('generates a native splash image that actually exists', () => {
    expect(appConfig).toContain("const splashImage = './assets/icon.png'");
    expect(appConfig).toMatch(/'expo-splash-screen',[\s\S]*?image: splashImage/);
    expect(appConfig).toMatch(/splash: \{[\s\S]*?image: splashImage/);
  });
});
