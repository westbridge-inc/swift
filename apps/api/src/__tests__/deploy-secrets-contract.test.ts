import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_FILE_NAMES } from '../utils/secret-files';

// ---------------------------------------------------------------------------
// The deploy tree never puts a secret where Docker, git, a backup or a process
// listing can read it back:
//   - the Compose file wires every secret as NAME_FILE=/run/secrets/NAME over a
//     read-only tmpfs mount, never as a container environment VALUE;
//   - the env template declares no secret at all;
//   - no script passes a secret value in argv (values travel on stdin or in
//     files the owning process reads itself).
// The allowlist is imported from the loader, so the app and the deploy tree
// cannot drift apart about what counts as a secret.
// ---------------------------------------------------------------------------

const DEPLOY = join(__dirname, '..', '..', '..', '..', 'deploy');
const read = (rel: string): string => readFileSync(join(DEPLOY, rel), 'utf8');

/** Consumer-side spellings of the same secrets: the images read these names. */
const CONSUMER_ALIASES = ['MEILI_MASTER_KEY', 'PGPASSWORD', 'MEILI_MASTER_KEY_FILE_VALUE'];
const SECRET = new Set<string>([...SECRET_FILE_NAMES]);

interface Service {
  environment: Record<string, string>;
  volumes: string[];
  envFile: string[];
  command?: string;
  entrypoint?: string;
}

/** A deliberately small reader for the shape docker-compose.yml actually uses. */
function parseCompose(text: string): Record<string, Service> {
  const services: Record<string, Service> = {};
  let inServices = false;
  let service: Service | null = null;
  let section: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) {
      inServices = line === 'services:';
      service = null;
      section = null;
      continue;
    }
    if (!inServices) continue;
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      service = { environment: {}, volumes: [], envFile: [] };
      services[header[1] as string] = service;
      section = null;
      continue;
    }
    if (!service) continue;
    const key = line.match(/^ {4}([\w-]+):(.*)$/);
    if (key) {
      section = key[1] as string;
      const inline = (key[2] ?? '').trim();
      if (section === 'command') service.command = inline;
      if (section === 'entrypoint') service.entrypoint = inline;
      if (section === 'env_file' && inline) service.envFile.push(inline);
      continue;
    }
    const entry = line.match(/^ {6}(.*)$/);
    if (!entry) continue;
    const body = (entry[1] as string).trim();
    if (section === 'environment') {
      const map = body.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      const list = body.match(/^- ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (map) service.environment[map[1] as string] = (map[2] ?? '').replace(/^"(.*)"$/, '$1');
      else if (list) service.environment[list[1] as string] = list[2] ?? '';
    } else if (section === 'volumes' && body.startsWith('- ')) {
      service.volumes.push(body.slice(2).replace(/^"(.*)"$/, '$1'));
    } else if (section === 'env_file' && body.startsWith('- ')) {
      service.envFile.push(body.slice(2));
    }
  }
  return services;
}

const compose = parseCompose(read('docker-compose.yml'));
const SECRET_MOUNT = '/run/swift-secrets:/run/secrets:ro';

describe('docker-compose.yml — secrets are files on tmpfs, never container environment', () => {
  it('parsed the services it is about to grade', () => {
    for (const name of ['postgres', 'meilisearch', 'migrate', 'api', 'worker', 'caddy']) expect(Object.keys(compose), name).toContain(name);
    expect(Object.keys(compose['api']?.environment ?? {}).length).toBeGreaterThan(3);
  });

  it('no service carries an allowlisted secret, or a consumer alias of one, as an environment key', () => {
    for (const [name, service] of Object.entries(compose)) {
      for (const key of Object.keys(service.environment)) {
        expect(SECRET.has(key), `${name}.environment.${key} is a secret value in container config`).toBe(false);
        expect(CONSUMER_ALIASES.includes(key), `${name}.environment.${key} is a secret value in container config`).toBe(false);
      }
    }
  });

  it('no environment value interpolates a secret from deploy/.env', () => {
    const text = read('docker-compose.yml');
    for (const name of [...SECRET_FILE_NAMES, ...CONSUMER_ALIASES]) {
      expect(text, `\${${name}} would pull a secret out of deploy/.env`).not.toMatch(new RegExp(`\\$\\{${name}[:}]`));
    }
  });

  it('every *_FILE key names an allowlisted secret and points at /run/secrets/NAME', () => {
    let wired = 0;
    for (const [name, service] of Object.entries(compose)) {
      for (const [key, value] of Object.entries(service.environment)) {
        if (!key.endsWith('_FILE')) continue;
        const secret = key.slice(0, -'_FILE'.length);
        expect(SECRET.has(secret), `${name}.environment.${key}: ${secret} is not in the loader allowlist`).toBe(true);
        expect(value, `${name}.environment.${key}`).toBe(`/run/secrets/${secret}`);
        wired += 1;
      }
    }
    expect(wired).toBeGreaterThanOrEqual(10);
  });

  it('every service that reads a secret file mounts the tmpfs store read-only at /run/secrets', () => {
    for (const [name, service] of Object.entries(compose)) {
      const readsFiles = Object.keys(service.environment).some((k) => k.endsWith('_FILE')) || /\/run\/secrets\//.test(service.command ?? '');
      if (!readsFiles) continue;
      expect(service.volumes, `${name} must mount ${SECRET_MOUNT}`).toContain(SECRET_MOUNT);
    }
    for (const name of ['postgres', 'meilisearch', 'migrate', 'api', 'worker']) {
      expect(compose[name]?.volumes, name).toContain(SECRET_MOUNT);
    }
  });

  it('the app processes get the database credential as parts plus a password file — never a URL with the password inside', () => {
    for (const name of ['migrate', 'api', 'worker']) {
      const env = compose[name]?.environment ?? {};
      expect(env['DATABASE_URL'], `${name}.environment.DATABASE_URL`).toBeUndefined();
      expect(env['POSTGRES_PASSWORD_FILE'], name).toBe('/run/secrets/POSTGRES_PASSWORD');
      for (const part of ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_DB']) {
        expect(env[part], `${name}.environment.${part}`).toBeTruthy();
      }
    }
    expect(compose['postgres']?.environment['POSTGRES_PASSWORD_FILE']).toBe('/run/secrets/POSTGRES_PASSWORD');
  });

  it('api and worker wire every generated secret through a file', () => {
    for (const name of ['api', 'worker']) {
      const env = compose[name]?.environment ?? {};
      for (const secret of ['JWT_SECRET', 'OTP_HASH_SECRET', 'MASTER_KEK', 'STORAGE_SIGNING_SECRET', 'CONSENT_IP_PEPPER', 'MEILISEARCH_KEY']) {
        expect(env[`${secret}_FILE`], `${name}.environment.${secret}_FILE`).toBe(`/run/secrets/${secret}`);
      }
    }
  });

  it('meilisearch reads its master key from the file inside its own process, keeps tini as PID 1, and never in argv or config', () => {
    const meili = compose['meilisearch'] as Service;
    expect(meili.entrypoint).toBeUndefined();
    expect(meili.command).toContain('cat /run/secrets/MEILISEARCH_KEY');
    expect(meili.command).toContain('exec /bin/meilisearch');
    expect(meili.command).not.toMatch(/--master-key/);
    // `$$` is Compose escaping: the shell, not Compose, expands the substitution.
    expect(meili.command).toContain('$$(cat');
    expect(meili.environment['MEILI_MASTER_KEY']).toBeUndefined();
  });

  it('migrate runs the Prisma CLI through the secret-file loader', () => {
    expect(compose['migrate']?.command).toContain('dist/boot/migrate-deploy.js');
  });
});

describe('deploy/.env.deploy.example — the template declares no secret', () => {
  const template = read('.env.deploy.example');

  it('has no NAME= line, commented or not, for any allowlisted secret', () => {
    for (const line of template.split('\n')) {
      const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/);
      if (!m) continue;
      const name = m[1] as string;
      expect(SECRET.has(name), `${JSON.stringify(line)} — ${name} belongs in the encrypted store`).toBe(false);
      expect(CONSUMER_ALIASES.includes(name), line).toBe(false);
    }
  });

  it('documents the *_FILE wiring for the optional provider secrets it names', () => {
    for (const name of ['TWILIO_API_KEY_SECRET', 'SMTP_PASS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'MMG_API_KEY', 'MMG_PASSWORD']) {
      expect(template, name).toContain(`${name}_FILE=/run/secrets/${name}`);
    }
  });
});

describe('scripts — no secret value ever rides in argv', () => {
  const scripts = readdirSync(DEPLOY)
    .filter((f) => /\.(sh|yml|service|timer)$/.test(f) || f === 'swift-secrets')
    .map((f) => [f, read(f)] as const)
    .concat(readdirSync(join(DEPLOY, 'owner')).map((f) => [`owner/${f}`, read(`owner/${f}`)] as const));

  it('graded a real set of files', () => {
    expect(scripts.map(([f]) => f)).toEqual(expect.arrayContaining(['swift-secrets', 'gen-secrets.sh', 'pilot-up.sh', 'backup.sh', 'owner/swift-secrets-prompt.command']));
    expect(statSync(join(DEPLOY, 'swift-secrets')).mode & 0o111).not.toBe(0);
    expect(statSync(join(DEPLOY, 'owner', 'swift-secrets-prompt.command')).mode & 0o111).not.toBe(0);
  });

  it('every `swift-secrets set` call passes exactly one argument — the name', () => {
    let calls = 0;
    for (const [file, text] of scripts) {
      for (const line of text.split('\n')) {
        if (line.trim().startsWith('#')) continue;
        for (const m of line.matchAll(/swift-secrets(?:"|')?\s+set\s+([^|&;>()]*)/g)) {
          calls += 1;
          const args = (m[1] as string).trim().split(/\s+/).filter(Boolean);
          expect(args.length, `${file}: ${line.trim()}`).toBe(1);
        }
      }
    }
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('the store encrypts from stdin and decrypts to stdout — systemd-creds never sees a value in argv', () => {
    const store = read('swift-secrets');
    const encrypt = store.split('\n').filter((l) => /systemd-creds\s+encrypt/.test(l) && !l.trim().startsWith('#'));
    const decrypt = store.split('\n').filter((l) => /systemd-creds\s+decrypt/.test(l) && !l.trim().startsWith('#'));
    expect(encrypt.length).toBeGreaterThanOrEqual(1);
    expect(decrypt.length).toBeGreaterThanOrEqual(1);
    for (const line of encrypt) expect(line).toMatch(/encrypt\s+.*\s-\s/);
    for (const line of decrypt) expect(line).toMatch(/\s-(\s|$)/);
    expect(store).toContain('--with-key=host');
    expect(store).toMatch(/--name="?\$/);
  });

  it('the owner tool sends the value on stdin only and prints only "saved NAME"', () => {
    const tool = read('owner/swift-secrets-prompt.command');
    expect(tool).toMatch(/\bread\s+(?:-r\s+)?-r?s\b/);
    expect(tool).toMatch(/printf '%s' "\$value" \| "\$\{SSH\[@\]\}"/);
    expect(tool).toContain('sudo -n swift-secrets set');
    expect(tool).not.toMatch(/echo\s+"?\$value/);
    expect(tool).not.toMatch(/set \$name \$value|set \$name "\$value"|\$\{value\}"?\s*$/m);
    expect(tool).not.toMatch(/mktemp|> ?\/tmp|tee /);
    expect(tool).toMatch(/echo "saved \$name"/);
  });

  it('gen-secrets.sh pipes every generated value into the store and writes none of them to .env', () => {
    const gen = read('gen-secrets.sh');
    for (const name of ['MASTER_KEK', 'JWT_SECRET', 'OTP_HASH_SECRET', 'STORAGE_SIGNING_SECRET', 'CONSENT_IP_PEPPER', 'POSTGRES_PASSWORD', 'MEILISEARCH_KEY']) {
      expect(gen, name).toMatch(new RegExp(`\\|\\s*store set ${name}\\b`));
      expect(gen, name).not.toMatch(new RegExp(`echo "${name}=`));
    }
  });

  it('the in-container database commands take the password from POSTGRES_PASSWORD_FILE, never the environment', () => {
    for (const file of ['backup.sh', 'restore.sh', 'doctor.sh']) {
      const text = read(file);
      expect(text, file).toContain('POSTGRES_PASSWORD_FILE');
      expect(text, file).not.toMatch(/PGPASSWORD="\$POSTGRES_PASSWORD"/);
    }
  });

  it('the backup unit takes the storage keys from systemd encrypted credentials, not the env file', () => {
    const unit = read('swift-backup.service');
    expect(unit).toContain('LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred');
    expect(unit).toContain('LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred');
    expect(unit).not.toMatch(/Environment=AWS_/);
    expect(unit).toContain('BACKUP_REQUIRED=1');
  });

  it('the materialize unit is a oneshot that runs before Docker', () => {
    const unit = read('swift-secrets.service');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toMatch(/Before=.*docker\.service/);
    expect(unit).toMatch(/ExecStart=\S*swift-secrets materialize/);
  });
});
