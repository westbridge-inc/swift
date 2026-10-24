import { mkdir, writeFile, unlink, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { cleanStoredPhoto } from '../../utils/images';
import { storageSigningKeys } from '../../utils/signing-keys';
import { localStorageBaseDir, resolveLocalStorageKey, storageProviderKind } from './storage-key';
import { assertDurableStorageConfig } from './storage-config';

// ---------------------------------------------------------------------------
// StorageProvider — hard rule 4: swappable interface. Raw documents live in
// private, encrypted object storage; the DB stores only the fileKey. Access is
// always via a short-lived signed URL (Data Protection Act §3.5), never a
// public link, and every issuance is audit-logged at the call site.
// ---------------------------------------------------------------------------

export interface StorageProvider {
  /** Store bytes; returns the opaque fileKey to persist (never a public URL). */
  upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }>;
  /** Short-lived signed URL to view a stored object. Default TTL 5 min. */
  getSignedUrl(fileKey: string, ttlSeconds?: number): Promise<string>;
  /** Permanently delete an object (retention / right-to-erasure). */
  delete(fileKey: string): Promise<void>;

  /** Read an object's raw bytes (the decrypting render path needs the ciphertext). */
  getObject(fileKey: string): Promise<Buffer>;
}

/** [IMAGES-E2E] A bounded read for the public store-photo door: at most `maxBytes`
 *  of an object, null when it is missing or larger than that, honouring `signal`
 *  (the caller's deadline). Both adapters below implement it. */
export interface BoundedObjectReader {
  getObjectWithin(fileKey: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | null>;
}

export function canReadBounded(storage: StorageProvider): storage is StorageProvider & BoundedObjectReader {
  return typeof (storage as Partial<BoundedObjectReader>).getObjectWithin === 'function';
}

/**
 * [S8/C4] The one place every stored byte passes through.
 *
 * Photos arrive straight off a phone camera carrying EXIF — GPS coordinates,
 * capture time, device serial. Stripping it HERE rather than at the upload
 * routes is deliberate: there are seven of those today (selfie, rider docs,
 * driver docs, courier proof photo, admin, ads creative, vendor media) and the
 * eighth would forget. A new StorageProvider gets the guarantee for free.
 *
 * Non-image mime types (PDF documents, encrypted envelopes) pass through
 * untouched, as does anything that will not parse.
 */
async function sanitizeForStorage(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }) {
  // [Row 108 · fixes a privacy gap on main] What the bytes ARE decides how a photo is handled,
  // sniffed ONCE: the declared type never chooses the strip or the size check, so a mislabelled
  // photo (a renamed file, a PNG sent as image/jpeg) loses its location like any other. A photo
  // that cannot be cleaned or read is refused, never stored as it came (fail closed).
  // [Row 238] The same helper cleans an ID photo before it is sealed, so there is one clean-up.
  const photo = await cleanStoredPhoto(input.buffer, input.mimeType);
  return photo ? { ...input, ...photo } : input; // not a photo: a PDF, an encrypted envelope, a video
}

const DEFAULT_TTL_SECONDS = 300;
const PATH_ESCAPE = 'Invalid file key: path escapes the uploads directory';

/** Shared by both adapters so tests can prove the exact server-issued object
 * name contract without performing filesystem or provider I/O. Callers that
 * require a constrained extension must provide a canonical filename. */
export function createOpaqueStorageName(filename: string): string {
  const ext = path.extname(filename) || '.bin';
  return `${nanoid(16)}${ext}`;
}

/** Local-disk adapter for dev/test. Files land under UPLOAD_DIR (gitignored). */
export class LocalStorageProvider implements StorageProvider, BoundedObjectReader {
  private baseDir = localStorageBaseDir();
  // [M-37] Resolved through the keyring: production never falls open to the repository default.
  private get signingSecret(): string { return storageSigningKeys().current.secret; }
  private publicBase = process.env['API_PUBLIC_URL'] ?? '';

  constructor() {
    assertDurableStorageConfig({ ...process.env, STORAGE_PROVIDER: 'local' });
  }

  async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }> {
    assertDurableStorageConfig({ ...process.env, STORAGE_PROVIDER: 'local' });
    if (localStorageBaseDir() !== this.baseDir) throw new Error('Storage root changed; restart with a validated storage configuration');
    const safe = await sanitizeForStorage(input);
    const name = createOpaqueStorageName(safe.filename);
    // Checked HERE, next to the writes: the folder (a server-chosen subfolder such as
    // "verification/<id>") must resolve strictly inside the uploads folder, and so must the file.
    const dir = path.resolve(path.join(this.baseDir, safe.folder));
    const file = path.resolve(dir, name);
    if (safe.folder.includes('\0') || !dir.startsWith(this.baseDir + path.sep) || !file.startsWith(dir + path.sep)) {
      throw new Error(PATH_ESCAPE);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(file, safe.buffer);
    return { url: `/uploads/${safe.folder}/${name}` };
  }

  /** Dev signed URL: HMAC over key+expiry so it is time-limited, not a raw link. */
  async getSignedUrl(fileKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = crypto
      .createHmac('sha256', this.signingSecret)
      .update(`${fileKey}:${expires}`)
      .digest('hex')
      .slice(0, 32);
    return `${this.publicBase}${fileKey}?expires=${expires}&sig=${sig}`;
  }

  /** Map a stored "/uploads/..." key to a disk path, refusing any '..' escape.
   *  Defence-in-depth: keys come from the DB (nanoid names), but a poisoned key
   *  must never let getObject/delete read or unlink outside the uploads dir.
   *  Every method below ALSO checks the path it touches inline, next to the fs call. */
  private resolveKey(fileKey: string): string {
    return path.resolve(resolveLocalStorageKey(fileKey, this.baseDir));
  }

  async delete(fileKey: string): Promise<void> {
    const abs = this.resolveKey(fileKey); // an escaping key throws (refused, as always)
    // The uploads folder itself is never a stored file: nothing to delete.
    if (!abs.startsWith(this.baseDir + path.sep)) return;
    // best-effort: a missing file (or any unlink failure) is swallowed here.
    await unlink(abs).catch(() => undefined);
  }

  async getObject(fileKey: string): Promise<Buffer> {
    const abs = this.resolveKey(fileKey);
    // Only a file INSIDE the uploads folder is ever read (the folder itself is no object).
    if (!abs.startsWith(this.baseDir + path.sep)) throw new Error(PATH_ESCAPE);
    return readFile(abs);
  }

  async getObjectWithin(fileKey: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
    const abs = this.resolveKey(fileKey);
    // Only a file INSIDE the uploads folder is ever read here (the folder itself is no photo).
    if (!abs.startsWith(this.baseDir + path.sep)) return null;
    try {
      const s = await stat(abs);
      if (!s.isFile() || s.size > maxBytes) return null;
      const bytes = await readFile(abs, { signal });
      return bytes.length > maxBytes ? null : bytes;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
  }
}

/**
 * S3-compatible adapter — works for AWS S3 and Cloudflare R2 (set AWS_S3_ENDPOINT
 * + path-style for R2). Objects are private; uploads request encryption at rest.
 */
export class S3StorageProvider implements StorageProvider, BoundedObjectReader {
  private client: S3Client;
  private bucket = process.env['AWS_S3_BUCKET'] ?? '';
  private endpoint = process.env['AWS_S3_ENDPOINT']; // set for R2 / S3-compatible
  private sse = process.env['AWS_S3_SSE'] ?? 'AES256';

  constructor() {
    if (!this.bucket) throw new Error('AWS_S3_BUCKET is required for the s3 storage provider');
    this.client = new S3Client({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      ...(this.endpoint && { endpoint: this.endpoint, forcePathStyle: true }),
    });
  }

  async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }> {
    const safe = await sanitizeForStorage(input);
    const key = `${safe.folder}/${createOpaqueStorageName(safe.filename)}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: safe.buffer,
        ContentType: safe.mimeType,
        // R2 rejects unknown SSE headers; only send for native S3 (no endpoint).
        ...(!this.endpoint && { ServerSideEncryption: this.sse as 'AES256' }),
      }),
    );
    return { url: key };
  }

  async getSignedUrl(fileKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<string> {
    return presignS3(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: fileKey }),
      { expiresIn: ttlSeconds },
    );
  }

  async delete(fileKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }));
  }

  async getObject(fileKey: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: fileKey }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty object body for ${fileKey}`);
    return Buffer.from(bytes);
  }

  async getObjectWithin(fileKey: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: fileKey }), { abortSignal: signal });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
    const body = res.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    if (!body) return null;
    if (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes) { body.destroy?.(); return null; }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) { body.destroy?.(); return null; }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }
}

/** Provider selection is config, not code. */
export function getStorageProvider(): StorageProvider {
  assertDurableStorageConfig();
  const provider = storageProviderKind();
  switch (provider) {
    case 'local':
      return new LocalStorageProvider();
    case 's3':
    case 'r2':
      return new S3StorageProvider();
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: ${provider}`);
  }
}
