import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
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
import { stripImageMetadata } from '../../utils/images';

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
function sanitizeForStorage(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }) {
  return { ...input, buffer: stripImageMetadata(input.buffer, input.mimeType) };
}

const DEFAULT_TTL_SECONDS = 300;

/** Local-disk adapter for dev/test. Files land under UPLOAD_DIR (gitignored). */
export class LocalStorageProvider implements StorageProvider {
  private baseDir = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'uploads');
  private signingSecret = process.env['STORAGE_SIGNING_SECRET'] ?? 'dev-signing-secret';
  private publicBase = process.env['API_PUBLIC_URL'] ?? '';

  async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }> {
    const safe = sanitizeForStorage(input);
    const ext = path.extname(safe.filename) || '.bin';
    const name = `${nanoid(16)}${ext}`;
    const dir = path.join(this.baseDir, safe.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), safe.buffer);
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
   *  must never let getObject/delete read or unlink outside the uploads dir. */
  private resolveKey(fileKey: string): string {
    const rel = fileKey.replace(/^\/?uploads\//, '');
    const full = path.resolve(this.baseDir, rel);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + path.sep)) {
      throw new Error('Invalid file key: path escapes the uploads directory');
    }
    return full;
  }

  async delete(fileKey: string): Promise<void> {
    // best-effort; a bad key resolves to a throw, swallowed here.
    await unlink(this.resolveKey(fileKey)).catch(() => undefined);
  }

  async getObject(fileKey: string): Promise<Buffer> {
    return readFile(this.resolveKey(fileKey));
  }
}

/**
 * S3-compatible adapter — works for AWS S3 and Cloudflare R2 (set AWS_S3_ENDPOINT
 * + path-style for R2). Objects are private; uploads request encryption at rest.
 */
export class S3StorageProvider implements StorageProvider {
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
    const safe = sanitizeForStorage(input);
    const ext = path.extname(safe.filename) || '.bin';
    const key = `${safe.folder}/${nanoid(16)}${ext}`;
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
}

/** Provider selection is config, not code. */
export function getStorageProvider(): StorageProvider {
  const provider = process.env['STORAGE_PROVIDER'] ?? 'local';
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
