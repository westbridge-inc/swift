import path from 'node:path';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { REVIEW_PACK_IMAGE_DIR, reviewPackPicture } from '../modules/review/content-pack';
import { REVIEW_PARTNER_PORTRAIT_DIR, reviewPartnerPortrait } from '../modules/review/partner-pack';

// Only explicitly public upload trees are ever served statically. KYC /
// verification documents live under other /uploads folders and stay private —
// they are only reachable through short-lived signed URLs.
//   items/    — menu & catalogue photos
//   avatars/  — the mandatory signup selfie, each user's public profile photo
//   vehicles/ — the driver's exterior car photo, shown on ride acceptance
export const PUBLIC_UPLOAD_FOLDERS = ['items', 'avatars', 'vehicles'] as const;

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
      // [STA-1 Part 6] The review content pack's item pictures are DRAWN from
      // the pack itself (modules/review/pack-image.ts), never read from disk:
      // the same bytes in every process and on every deploy. Only a picture
      // the pack declares exists; any other name under this prefix is a 404.
      if (folder === 'items' && rel.startsWith(REVIEW_PACK_IMAGE_DIR)) {
        const png = reviewPackPicture(rel.slice(REVIEW_PACK_IMAGE_DIR.length));
        if (!png) return reply.code(404).send();
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(png);
      }
      // [REVIEW-PARTNER] The fiction's rider and driver have DRAWN profile
      // photos (review/partner-pack.ts), never a camera image: same rule.
      if (folder === 'avatars' && rel.startsWith(REVIEW_PARTNER_PORTRAIT_DIR)) {
        const png = reviewPartnerPortrait(rel.slice(REVIEW_PARTNER_PORTRAIT_DIR.length));
        if (!png) return reply.code(404).send();
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(png);
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
