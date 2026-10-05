import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('MASTER-073 API-resolved multipart parser', () => {
  it.each(['ordinary', 'prototype-headers', 'long-boundary'])('finishes the bounded %s fixture in a disposable child', (kind) => {
    const script = `
      const req = require('node:module').createRequire(${JSON.stringify(require.resolve('@fastify/multipart'))});
      const version = req('@fastify/busboy/package.json').version;
      const [major, minor, patch] = version.split('.').map(Number);
      if (!(major > 3 || major === 3 && (minor > 2 || minor === 2 && patch >= 1))) {
        console.log(JSON.stringify({blockedUnpatchedVersion: version}));
        process.exit(2); // never send the fixtures to an unpatched parser
      }
      const kind = ${JSON.stringify(kind)};
      const boundary = kind === 'long-boundary' ? 'a'.repeat(252) : 'synthetic-boundary';
      const extra = kind === 'prototype-headers' ? '__proto__: synthetic\\r\\nconstructor: synthetic\\r\\n' : '';
      const body = '--'+boundary+'\\r\\n'+extra+'Content-Disposition: form-data; name="field"\\r\\n\\r\\n42\\r\\n--'+boundary+'--\\r\\n';
      const Busboy = req('@fastify/busboy');
      const parser = new Busboy({headers: {'content-type': 'multipart/form-data; boundary='+boundary}, limits: {fields: 1, files: 1, fieldSize: 128}});
      const fields = [];
      parser.on('field', (name, value) => fields.push([name,value]));
      parser.on('error', () => { console.log(JSON.stringify({handledError:true, version})); process.exit(0); });
      parser.on('finish', () => console.log(JSON.stringify({fields, version})));
      parser.end(body);
    `;
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', script], {
      env: {}, timeout: 3000, maxBuffer: 64 * 1024, encoding: 'utf8',
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const outcome = JSON.parse(result.stdout.trim());
    if (kind === 'ordinary' || kind === 'prototype-headers') expect(outcome.fields).toEqual([['field', '42']]);
    else expect(outcome.handledError === true || outcome.fields?.[0]?.[1] === '42').toBe(true);
  });
});
