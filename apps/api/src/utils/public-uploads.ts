import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// Only explicitly public upload trees are ever served statically. KYC /
// verification documents live under other /uploads folders and stay private —
// they are only reachable through short-lived signed URLs.
//   items/    — menu & catalogue photos
//   avatars/  — the mandatory signup selfie, each user's public profile photo
export const PUBLIC_UPLOAD_FOLDERS = ['items', 'avatars'] as const;

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Registers the path-traversal-guarded static handlers for the public upload
 * folders. Kept out of server.ts so tests can mount it next to upload routes
 * and verify a stored file really is reachable.
 */
export function registerPublicUploads(app: FastifyInstance, uploadBase: string) {
  for (const folder of PUBLIC_UPLOAD_FOLDERS) {
    app.get<{ Params: { '*': string } }>(`/uploads/${folder}/*`, async (request, reply) => {
      const rel = request.params['*'];
      if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
        return reply.code(400).send({ error: 'bad path' });
      }
      const abs = path.join(uploadBase, folder, rel);
      try {
        const s = await stat(abs);
        if (!s.isFile()) return reply.code(404).send();
      } catch {
        return reply.code(404).send();
      }
      const ext = path.extname(abs).toLowerCase();
      return reply
        .header('Content-Type', IMAGE_MIME[ext] ?? 'application/octet-stream')
        .header('Cache-Control', 'public, max-age=86400')
        .send(createReadStream(abs));
    });
  }
}
