import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// The routing stack, and the port that silently degrades every ETA.
//
// OSRM, VROOM, Photon and Nominatim lived outside the repository — in a
// directory on one laptop, with a note saying they were kept out of the public
// repo deliberately. There are no secrets in them, and deploy/docker-compose.yml
// already publishes the whole topology, so what that bought was not privacy: it
// was a routing engine every ETA depends on that could not be rebuilt from
// anything if the laptop died.
//
// The copy that came in also carried a live trap. Each container publishes on a
// DIFFERENT host port than it listens on (5000→5001, 3000→3010), and the file's
// own comments told you to use the container port. Point the API at :5000 from
// the host and nothing errors — `maps-provider` falls back to haversine, and
// the only symptom is that every distance is quietly a little wrong.
// ---------------------------------------------------------------------------

const ROOT = join(process.cwd(), '../..');
const read = (rel: string) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

const COMPOSE = read('deploy/docker-compose.routing.yml');
const SETUP = read('deploy/setup-routing.sh');
const VROOM_CONF = read('deploy/routing-conf/vroom/config.yml');
const GITIGNORE = read('.gitignore');

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
  /** host:container for a published port. */
  const ports = [...COMPOSE.matchAll(/"(\d+):(\d+)"/g)].map((m) => ({ host: m[1]!, container: m[2]! }));

  it('publishes OSRM and VROOM on host ports that differ from the container', () => {
    expect(ports).toEqual(
      expect.arrayContaining([
        { host: '5001', container: '5000' },
        { host: '3010', container: '3000' },
      ]),
    );
  });

  it('documents the HOST port for every service the API reaches', () => {
    // The trap this file exists for. `OSRM_URL=http://<host>:5000` is the
    // CONTAINER port — correct only from inside the compose network, wrong for
    // the API. Nothing errors: maps-provider falls back to haversine and every
    // distance is quietly a little worse.
    for (const [name, url] of [
      ['OSRM', 'OSRM_URL=http://<host>:5001'],
      ['VROOM', 'VROOM_URL=http://<host>:3010'],
      ['Photon', 'PHOTON_URL=http://<host>:2322'],
      ['Nominatim', 'NOMINATIM_URL=http://<host>:8080'],
    ] as const) {
      expect(COMPOSE + SETUP, `${name}'s documented URL is missing or wrong`).toContain(url);
    }
  });

  it('never documents the container port as the API\'s URL', () => {
    expect(COMPOSE + SETUP).not.toMatch(/OSRM_URL=http:\/\/<host>:5000/);
    expect(COMPOSE + SETUP).not.toMatch(/VROOM_URL=http:\/\/<host>:3000/);
  });

  it('vroom reaches OSRM by CONTAINER name and port — it is inside the network', () => {
    // The one place the container port is right, and for the opposite reason.
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

  it('says out loud that none of these services has authentication', () => {
    // Bringing this into a public repo without stating that is worse than
    // leaving it out.
    expect(COMPOSE).toMatch(/authentication|no auth/i);
    expect(COMPOSE).toMatch(/[Ff]irewall/);
  });
});
