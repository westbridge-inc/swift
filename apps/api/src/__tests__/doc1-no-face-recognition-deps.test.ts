/**
 * [DOC-1 §26 · DOC-INV-36] test_no_face_recognition_dependencies — proven by absence.
 *
 * No face-recognition or face-embedding library exists in the dependency tree of any
 * app or package: face matching is the KYC provider's, behind its interface, never
 * in-tree. The census walks every workspace manifest and the lockfile, so a library
 * pulled in transitively is caught too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..', '..', '..');
/** Package-name fragments that identify face recognition / embedding / biometric ML libraries. */
const FORBIDDEN = [
  'face-api', 'faceapi', '@vladmandic/face', 'face-recognition', 'facenet', 'insightface', 'deepface', 'arcface',
  'mediapipe', '@tensorflow-models/face', '@tensorflow-models/blazeface', 'blazeface', 'opencv', 'opencv4nodejs',
  'dlib', 'human', 'clmtrackr', 'tracking.js', 'pico.js', 'onnxruntime', '@tensorflow/tfjs', 'ml5',
];
const EXACT_ONLY = new Set(['human']); // too short to substring-match safely

function manifests(dir: string, out: string[] = [], depth = 0): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'build', '.expo', 'ios', 'android', 'target'].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (depth < 4) manifests(p, out, depth + 1); }
    else if (name === 'package.json') out.push(p);
  }
  return out;
}

describe('[DOC-INV-36] no face-recognition dependency, by absence', () => {
  it('test_no_face_recognition_dependencies: every workspace manifest and the lockfile are clean', () => {
    const files = manifests(REPO);
    expect(files.length).toBeGreaterThan(3);
    const offenders: string[] = [];
    for (const f of files) {
      const pkg = JSON.parse(readFileSync(f, 'utf8')) as Record<string, Record<string, string> | undefined>;
      const deps = { ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}), ...(pkg['optionalDependencies'] ?? {}), ...(pkg['peerDependencies'] ?? {}) };
      for (const name of Object.keys(deps)) {
        const lower = name.toLowerCase();
        for (const bad of FORBIDDEN) {
          if (EXACT_ONLY.has(bad) ? lower === bad : lower.includes(bad)) offenders.push(`${f.replace(REPO, '.')}: ${name}`);
        }
      }
    }
    const lock = join(REPO, 'pnpm-lock.yaml');
    if (existsSync(lock)) {
      const text = readFileSync(lock, 'utf8');
      for (const bad of FORBIDDEN.filter((b) => !EXACT_ONLY.has(b))) {
        const re = new RegExp(`^\\s{2}(/|')?${bad.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[^\\n]*:`, 'mi');
        if (re.test(text)) offenders.push(`pnpm-lock.yaml: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
