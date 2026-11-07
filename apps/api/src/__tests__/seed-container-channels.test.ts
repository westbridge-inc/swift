import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_CHANNEL_SETTINGS, unsetEmptyChannelSettings } from '../modules/ops/seed-plan';
import {
  channelSettingsReadInEveryProductionPosture, channelSettingsReadInProduction, isSecretSetting, PRODUCTION_EMAIL_POSTURES,
  SEED_COMPOSE, seedContainerEnvironment,
} from './helpers/seed-channel-settings';

// ---------------------------------------------------------------------------
// [SEED-FIX 27 Oct 2026] The owner's solo production re-seed (#2129) was
// refused at its start: the seed container had the email and text settings but
// not PUSH_PROVIDER, getChannels() builds every channel, and production refuses
// a dev push provider, so SOLO_EMAIL_UNAVAILABLE. Nothing changed on production.
//
// This file holds docker-compose.seed.yml to the code: every setting the
// channels read while they are built in production (recorded from getChannels()
// itself, never typed here) reaches the seed container from deploy/.env, the
// same way the api gets it — a secret only as its *_FILE from the store — and
// every one the container gets as text is unset when Compose hands it over empty.
// ---------------------------------------------------------------------------

// [EMAIL-HTTPS 27 Oct] Production boots on smtp OR resend email: the seed
// container carries what either one reads (deploy/.env picks one).
const read = channelSettingsReadInEveryProductionPosture();
const compose = seedContainerEnvironment();

describe('[SEED-FIX] the seed container gets every setting the notification channels read in production', () => {
  it('the recording sees the channels being built (so an empty recording can never pass the checks below)', () => {
    expect(read).toEqual(expect.arrayContaining(['NODE_ENV', 'NOTIFICATION_PROVIDER', 'PUSH_PROVIDER', 'EMAIL_PROVIDER', 'TWILIO_API_KEY_SECRET', 'SMTP_PASS', 'RESEND_API_KEY']));
  });

  it('[EMAIL-HTTPS] each email posture is recorded on its own: resend reads its key and no SMTP setting, smtp no Resend setting', () => {
    const smtp = channelSettingsReadInProduction(PRODUCTION_EMAIL_POSTURES.smtp);
    const resend = channelSettingsReadInProduction(PRODUCTION_EMAIL_POSTURES.resend);
    expect(resend).toEqual(expect.arrayContaining(['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM', 'RESEND_TIMEOUT_MS']));
    expect(resend.filter((name) => name.startsWith('SMTP_'))).toEqual([]);
    expect(smtp.filter((name) => name.startsWith('RESEND_'))).toEqual([]);
  });

  it('every one is passed by docker-compose.seed.yml from deploy/.env (a secret only as NAME_FILE, never as a value)', () => {
    const wrong: string[] = [];
    for (const name of read) {
      if (name === 'NODE_ENV') {
        // The posture is required, never defaulted (runtime-mode refuses to guess).
        if (!compose.get(name)?.startsWith('${NODE_ENV:?')) wrong.push(name);
      } else if (isSecretSetting(name)) {
        if (compose.get(`${name}_FILE`) !== `\${${name}_FILE:-}`) wrong.push(`${name}_FILE`);
        if (compose.has(name)) wrong.push(`${name} (a secret given as a value)`);
      } else if (compose.get(name) !== `\${${name}:-}`) {
        wrong.push(name);
      }
    }
    expect(wrong, 'settings the channels read in production that the seed container does not get from deploy/.env').toEqual([]);
  });

  it('the secret files come from the store, mounted read-only where the api reads them', () => {
    const text = readFileSync(SEED_COMPOSE, 'utf8');
    expect(text).toMatch(/^ {6}- \/run\/swift-secrets:\/run\/secrets:ro$/m);
    const example = readFileSync(join(process.cwd(), '../../deploy/.env.deploy.example'), 'utf8');
    for (const name of read.filter(isSecretSetting)) {
      expect(example, `${name}_FILE is wired from the store in deploy/.env`).toMatch(new RegExp(`^#? ?${name}_FILE=/run/secrets/${name}$`, 'm'));
    }
  });

  it('every one the container gets as text is unset when empty, and the list names nothing else', () => {
    const asText = read.filter((name) => name !== 'NODE_ENV' && !isSecretSetting(name)).sort();
    expect([...SEED_CHANNEL_SETTINGS].sort()).toEqual(asText);
  });

  it('unsetEmptyChannelSettings: an empty setting is unset, a set one is kept, nothing else is touched', () => {
    const env: Record<string, string | undefined> = { PUSH_PROVIDER: '', EMAIL_PROVIDER: 'smtp', SMTP_TLS: '', SEED_SOLO: '', OTHER: '' };
    unsetEmptyChannelSettings(env);
    expect(env).toEqual({ EMAIL_PROVIDER: 'smtp', SEED_SOLO: '', OTHER: '' });
  });
});
