import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The routing stack, and the private service URLs that every ETA depends on.
//
// OSRM, VROOM, Photon and Nominatim once lived outside the repository in a
// directory on one laptop. The checked-in Compose and rebuild script now make
// the stack recoverable while generated map data stays out of Git.
//
// The staging API and routing containers now share swift-pilot-private. Their
// URLs use service names and container ports; publishing host ports would expose
// unauthenticated routing services and is outside the deployment contract.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const COMPOSE = read('deploy/docker-compose.routing.yml');
const MAIN_COMPOSE = read('deploy/docker-compose.yml');
const SETUP = read('deploy/setup-routing.sh');
const VROOM_CONF = read('deploy/routing-conf/vroom/config.yml');
const GITIGNORE = read('.gitignore');
const serviceBlock = (source: string, name: string) => {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return '';
  const next = lines.slice(start + 1).findIndex((line) => /^ {2}[\w-]+:|^networks:/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : start + 1 + next).join('\n');
};

describe('[routing] the stack is in the repository', () => {
  it('every piece is here, not on one machine', () => {
    expect(COMPOSE.length, 'deploy/docker-compose.routing.yml is missing').toBeGreaterThan(500);
    expect(SETUP.length, 'deploy/setup-routing.sh is missing').toBeGreaterThan(300);
    expect(VROOM_CONF.length, "vroom's config is missing").toBeGreaterThan(100);
  });

  it('defines all four services', () => {
    for (const svc of ['osrm:', 'vroom:', 'photon:', 'nominatim:']) {
      expect(COMPOSE, `${svc} is not defined`).toContain(svc);
    }
  });

  it('pins every image — :latest is not a deployment', () => {
    // Except photon, whose publisher ships no version tags. Named so the
    // exception is a decision on the record rather than an oversight.
    const images = [...COMPOSE.matchAll(/image:\s*(\S+)/g)].map((m) => m[1]!);
    expect(images.length).toBe(4);
    const unpinned = images.filter((i) => i.endsWith(':latest'));
    expect(unpinned).toEqual(['rtuszik/photon-docker:latest']);
  });
});

describe('[routing] the documented URL is the one that works', () => {
  it('keeps every routing service off host ports on the API network', () => {
    expect(COMPOSE).not.toMatch(/^\s+ports:/m);
    expect(COMPOSE).toMatch(/^ {4}name: swift-pilot-private$/m);
    expect(MAIN_COMPOSE).toMatch(/^ {4}name: swift-pilot-private$/m);
    expect(serviceBlock(MAIN_COMPOSE, 'api')).toContain('networks: [private]');
    for (const name of ['osrm', 'vroom', 'photon', 'nominatim']) {
      expect(serviceBlock(COMPOSE, name), `${name} is not on the private network`).toContain('networks: [private]');
    }
  });

  it('documents each private service URL with its container port', () => {
    for (const [name, url] of [
      ['OSRM', 'OSRM_URL=http://osrm:5000'],
      ['VROOM', 'VROOM_URL=http://vroom:3000'],
      ['Photon', 'PHOTON_URL=http://photon:2322'],
      ['Nominatim', 'NOMINATIM_URL=http://nominatim:8080'],
    ] as const) {
      expect(COMPOSE + SETUP, `${name}'s documented URL is missing or wrong`).toContain(url);
    }
  });

  it('does not document host URLs for private routing services', () => {
    expect(COMPOSE + SETUP).not.toMatch(/(?:OSRM|VROOM|PHOTON|NOMINATIM)_URL=http:\/\/<host>:/);
  });

  it('vroom reaches OSRM by CONTAINER name and port — it is inside the network', () => {
    // VROOM uses the same private service-name convention as the API.
    expect(VROOM_CONF).toMatch(/host:\s*'osrm'/);
    expect(VROOM_CONF).toMatch(/port:\s*'5000'/);
  });
});

describe('[routing] the data is rebuildable and never committed', () => {
  it('the build script can refresh, and says why that matters', () => {
    // A stack can quietly run on months-old OSM data, because the script
    // reuses an existing download. The refresh path has to exist AND be
    // findable, or contributing to OpenStreetMap never reaches this app.
    expect(SETUP).toContain('--refresh');
    expect(SETUP).toMatch(/rm -f "\$PBF"/);
    expect(SETUP).toMatch(/OpenStreetMap/);
  });

  it('reports how old the data it is reusing actually is', () => {
    // Silence here is how two-month-old routing data goes unnoticed.
    expect(SETUP).toMatch(/date -r/);
  });

  it('the built data is gitignored — it is reproducible, and large', () => {
    expect(GITIGNORE).toContain('deploy/routing-data/');
    // vroom-express writes its access log into the mounted conf directory,
    // which IS committed. The log had already reached 5 MB on one laptop.
    expect(GITIGNORE).toContain('deploy/routing-conf/vroom/access.log');
  });

  it('pins Photon to a REGION, because the missing value is the dangerous one', () => {
    // Measured by starting the container three ways:
    //   unset / COUNTRY_CODE  → PLANET, 58.05 GB, no warning at all
    //   REGION=GY             → refused outright (honest)
    //   REGION=south-america  → 6.72 GB, which is what Guyana needs
    //
    // The first is the trap: the image does not read COUNTRY_CODE, so that
    // spelling silently becomes "download the planet". A region must be set,
    // and it must be one this image accepts — continents and a few
    // sub-regions, of which South America has only Argentina.
    // Read the CONFIG, not the prose. The comment above the service explains
    // the COUNTRY_CODE trap by name, so a whole-file search finds it there and
    // reports a problem that does not exist — the same mistake as matching on
    // a diagnosis string instead of an error code.
    const config = COMPOSE.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(config, 'Photon has no REGION — it will download the 58 GB planet').toMatch(/REGION=south-america/);
    expect(config, 'COUNTRY_CODE is not read by this image').not.toMatch(/COUNTRY_CODE/);
  });

  it('warns that these unauthenticated services must stay unpublished', () => {
    expect(COMPOSE).toMatch(/no built-in authentication/i);
    expect(COMPOSE).toMatch(/UFW.*published.*ports/i);
  });
});
