import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoutAndSwitchExperience } from './advertiserExit';

const advertiserStack = readFileSync(
  join(process.cwd(), 'src/modules/advertiser/AdvertiserStack.tsx'),
  'utf8',
);
const teamScreen = readFileSync(
  join(process.cwd(), 'src/modules/advertiser/screens/AdvertiserTeamScreen.tsx'),
  'utf8',
);
const registerScreen = readFileSync(
  join(process.cwd(), 'src/modules/advertiser/screens/AdvertiserRegisterScreen.tsx'),
  'utf8',
);
const exitDialog = readFileSync(
  join(process.cwd(), 'src/modules/advertiser/AdvertiserExitDialog.tsx'),
  'utf8',
);

describe('advertiser experience exit', () => {
  it('clears advertiser intent before running the existing logout teardown', () => {
    const calls: string[] = [];

    logoutAndSwitchExperience({
      setIntent: (intent) => calls.push(`intent:${String(intent)}`),
      logout: () => calls.push('logout'),
    });

    expect(calls).toEqual(['intent:null', 'logout']);
  });

  it('keeps the switch action visible, explicit, confirmed, and scroll-safe', () => {
    expect(advertiserStack).toContain('options={{ title: \'Account\' }}');
    expect(teamScreen).toContain('label="Log out and switch experience"');
    expect(teamScreen).toContain('onPress={exitDialog.requestLogout}');
    expect(teamScreen).toContain('{exitDialog.logoutDialog}');
    expect(teamScreen).toMatch(/<ScrollView[\s\S]*paddingBottom: space\['3xl'\] \+ insets\.bottom/);

    expect(registerScreen).toContain('label="Log out and switch experience"');
    expect(registerScreen).toContain('onPress={exitDialog.requestLogout}');
    expect(registerScreen).toContain('{exitDialog.logoutDialog}');
    expect(registerScreen).toMatch(/<ScrollView[\s\S]*paddingBottom: space\['3xl'\] \+ insets\.bottom/);

    // The confirm is the shared log-out ask (its PopupCard, PopupTitle and
    // exactly-once exit are pinned by kit/logout-confirm.test.ts), in the
    // advertiser's own words, running the intent-first exit above.
    expect(exitDialog).toContain('useLogoutConfirm({');
    expect(exitDialog).toContain('Switch away from advertising?');
    expect(exitDialog).toContain("confirmLabel: 'Log out and switch experience'");
    expect(exitDialog).toContain('Stay in advertising');
    expect(exitDialog).toContain('logoutAndSwitchExperience({ setIntent, logout })');
  });
});
