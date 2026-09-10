import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3 } from '@aws-sdk/s3-request-presigner';
import { stripImageMetadata } from '../../utils/images';
import { storageSigningKeys } from '../../utils/signing-keys';

// ---------------------------------------------------------------------------
// StorageProvider — hard rule 4: swappable interface. Raw documents live in
// private, encrypted object storage; the DB stores only the fileKey. Access is
// always via a short-lived signed URL (Data Protection Act §3.5), never a
// public link, and every issuance is audit-logged at the call site.
// ---------------------------------------------------------------------------

export type StorageProbeResult = 'PRESENT' | 'ABSENT' | 'MISMATCH' | 'UNKNOWN';
export type StorageExactDeleteCapability = 'ATOMIC_GENERATION' | 'IMMUTABLE_APP_KEY' | 'UNSUPPORTED';
export type StorageGenerationIdentification =
  | { status: 'PRESENT'; objectVersion: string }
  | { status: 'ABSENT' | 'UNKNOWN' };

export interface StoredObjectReference {
  url: string;
  /** Opaque provider generation token, used on every later read/delete. */
  objectVersion: string;
}

export interface StorageUploadInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  folder: string;
  /** Exact key previously returned by reserveKey(). */
  fileKey?: string;
}

export interface StorageReadOptions {
  /** Hard ceiling enforced while streaming, before a full object is buffered. */
  maxBytes?: number;
  signal?: AbortSignal;
}

export class StorageObjectTooLargeError extends Error {
  readonly code = 'STORAGE_OBJECT_TOO_LARGE';

  constructor(readonly maxBytes: number) {
    super(`Stored object exceeds the ${maxBytes}-byte read limit`);
    this.name = 'StorageObjectTooLargeError';
  }
}

export interface StorageProvider {
  /** Stable, non-secret identity of this adapter/location. */
  locationId(): string;
  /**
   * ATOMIC_GENERATION is a provider-enforced conditional delete. The local
   * adapter is safe only inside Swift's no-reuse/write-once key boundary.
   * Unsupported S3-compatible endpoints must fail before verification bytes
   * are accepted.
   */
  exactDeleteCapability(): StorageExactDeleteCapability;
  /** Reserve the exact object key before any bytes are written. */
  reserveKey(input: { filename: string; folder: string }): { url: string };
  /** Store bytes; returns the opaque fileKey to persist (never a public URL). */
  upload(input: StorageUploadInput): Promise<StoredObjectReference>;
  /** Short-lived signed URL to view a stored object. Default TTL 5 min. */
  getSignedUrl(fileKey: string, ttlSeconds?: number, objectVersion?: string): Promise<string>;
  /** Permanently delete an object (retention / right-to-erasure). */
  delete(fileKey: string): Promise<void>;
  /** Delete only the provider generation created by this upload claim. */
  deleteExact(fileKey: string, objectVersion: string): Promise<void>;

  /** Read an object's raw bytes (the decrypting render path needs the ciphertext). */
  getObject(fileKey: string, objectVersion?: string, options?: StorageReadOptions): Promise<Buffer>;
  /** Distinguish authoritative absence from an inconclusive provider error. */
  probe(fileKey: string, objectVersion?: string): Promise<StorageProbeResult>;
  /** Recover the provider generation after a process/DB failure lost the upload acknowledgement. */
  identifyGeneration(fileKey: string): Promise<StorageGenerationIdentification>;
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
function sanitizeForStorage(input: StorageUploadInput) {
  return { ...input, buffer: stripImageMetadata(input.buffer, input.mimeType) };
}

function safeFolder(folder: string): string {
  if (
    !folder
    || folder.startsWith('/')
    || folder.endsWith('/')
    || folder.includes('\\')
    || folder.includes('\0')
    || folder.includes('?')
    || folder.includes('#')
    || folder.includes('%')
    || folder.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid storage folder');
  }
  return folder;
}

function canonicalReservedKey(fileKey: string, folder: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(fileKey)) throw new Error('Invalid reserved storage key');
  const canonical = fileKey.replace(/^\/?uploads\//, '');
  const prefix = `${safeFolder(folder)}/`;
  if (
    !canonical.startsWith(prefix)
    || canonical.length === prefix.length
    || canonical.slice(prefix.length).includes('/')
    || canonical.includes('\\')
    || canonical.includes('\0')
    || canonical.includes('?')
    || canonical.includes('#')
    || canonical.includes('%')
  ) {
    throw new Error('Reserved storage key does not match its folder');
  }
  return canonical;
}

function locationFingerprint(kind: string, value: string): string {
  return `${kind}:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof value.code === 'string') return value.code;
  if (typeof value.name === 'string') return value.name;
  return typeof value.$metadata?.httpStatusCode === 'number'
    ? String(value.$metadata.httpStatusCode)
    : undefined;
}

function digestVersion(buffer: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function encodeProviderVersion(kind: 'version' | 'etag', value: string): string {
  return `s3-${kind}:${Buffer.from(value, 'utf8').toString('base64url')}`;
}

function decodeProviderVersion(token: string): { VersionId?: string; IfMatch?: string } | null {
  const match = /^(s3-version|s3-etag):([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) return null;
  let value: string;
  try {
    value = Buffer.from(match[2]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!value) return null;
  return match[1] === 's3-version' ? { VersionId: value } : { IfMatch: value };
}

const DEFAULT_TTL_SECONDS = 300;

type ReadableObjectBody = AsyncIterable<Uint8Array> & {
  destroy?: () => void;
  transformToByteArray?: () => Promise<Uint8Array>;
};

function readLimit(options: StorageReadOptions): number {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid storage read limit');
  return maxBytes;
}

async function collectBoundedBody(body: ReadableObjectBody, options: StorageReadOptions): Promise<Buffer> {
  const maxBytes = readLimit(options);
  options.signal?.throwIfAborted();
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const rawChunk of body) {
      options.signal?.throwIfAborted();
      const chunk = Buffer.from(rawChunk);
      total += chunk.length;
      if (total > maxBytes) {
        body.destroy?.();
        throw new StorageObjectTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
    options.signal?.throwIfAborted();
    return Buffer.concat(chunks, total);
  }
  if (!body.transformToByteArray) throw new Error('Storage provider returned an unreadable object body');
  const bytes = await body.transformToByteArray();
  options.signal?.throwIfAborted();
  if (bytes.byteLength > maxBytes) throw new StorageObjectTooLargeError(maxBytes);
  return Buffer.from(bytes);
}

/** Local-disk adapter for dev/test. Files land under UPLOAD_DIR (gitignored). */
export class LocalStorageProvider implements StorageProvider {
  private baseDir: string;
  // [M-37] Resolved through the keyring: production never falls open to the repository default.
  private get signingSecret(): string { return storageSigningKeys().current.secret; }
  private publicBase: string;

  constructor(options: { baseDir?: string; publicBase?: string } = {}) {
    this.baseDir = options.baseDir ?? process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'uploads');
    this.publicBase = options.publicBase ?? process.env['API_PUBLIC_URL'] ?? '';
  }

  locationId(): string {
    return locationFingerprint('local', path.resolve(this.baseDir));
  }

  exactDeleteCapability(): StorageExactDeleteCapability {
    // Swift is the sole writer in this directory and upload() is O_EXCL. This
    // is not a claim about a hostile filesystem administrator.
    return 'IMMUTABLE_APP_KEY';
  }

  reserveKey(input: { filename: string; folder: string }): { url: string } {
    const folder = safeFolder(input.folder);
    const ext = path.extname(path.basename(input.filename)) || '.bin';
    return { url: `/uploads/${folder}/${nanoid(16)}${ext}` };
  }

  async upload(input: StorageUploadInput): Promise<StoredObjectReference> {
    const safe = sanitizeForStorage(input);
    const folder = safeFolder(safe.folder);
    const url = safe.fileKey ?? this.reserveKey({ filename: safe.filename, folder }).url;
    const canonical = canonicalReservedKey(url, folder);
    const name = path.basename(canonical);
    const dir = path.join(this.baseDir, folder);
    await mkdir(dir, { recursive: true });
    // Never overwrite an earlier generation, even if a key collision or a
    // stale reservation is accidentally reused.
    await writeFile(path.join(dir, name), safe.buffer, { flag: 'wx' });
    return { url: `/uploads/${canonical}`, objectVersion: digestVersion(safe.buffer) };
  }

  /** Dev signed URL: HMAC over key+expiry so it is time-limited, not a raw link. */
  async getSignedUrl(fileKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS, objectVersion?: string): Promise<string> {
    if (objectVersion && await this.probe(fileKey, objectVersion) !== 'PRESENT') {
      throw new Error('Stored object generation is unavailable');
    }
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

  async deleteExact(fileKey: string, objectVersion: string): Promise<void> {
    const probe = await this.probe(fileKey, objectVersion);
    if (probe === 'ABSENT') return;
    if (probe !== 'PRESENT') throw new Error('Stored object generation does not match deletion authority');
    await unlink(this.resolveKey(fileKey));
  }

  async getObject(fileKey: string, objectVersion?: string, options: StorageReadOptions = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const bytes = await collectBoundedBody(
      createReadStream(this.resolveKey(fileKey), { signal: options.signal }),
      options,
    );
    if (objectVersion && digestVersion(bytes) !== objectVersion) {
      throw new Error('Stored object generation does not match read authority');
    }
    return bytes;
  }

  async probe(fileKey: string, objectVersion?: string): Promise<StorageProbeResult> {
    try {
      const bytes = await readFile(this.resolveKey(fileKey));
      return objectVersion && digestVersion(bytes) !== objectVersion ? 'MISMATCH' : 'PRESENT';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? 'ABSENT' : 'UNKNOWN';
    }
  }

  async identifyGeneration(fileKey: string): Promise<StorageGenerationIdentification> {
    try {
      const bytes = await readFile(this.resolveKey(fileKey));
      return { status: 'PRESENT', objectVersion: digestVersion(bytes) };
    } catch (error) {
      return { status: errorCode(error) === 'ENOENT' ? 'ABSENT' : 'UNKNOWN' };
    }
  }
}

/**
 * S3-compatible adapter — works for AWS S3 and Cloudflare R2 (set AWS_S3_ENDPOINT
 * + path-style for R2). Objects are private; uploads request encryption at rest.
 */
export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;
  private endpoint: string | undefined; // set for R2 / S3-compatible
  private sse: string;

  constructor(options: { bucket?: string; endpoint?: string; region?: string; sse?: string } = {}) {
    this.bucket = options.bucket ?? process.env['AWS_S3_BUCKET'] ?? '';
    this.endpoint = options.endpoint ?? process.env['AWS_S3_ENDPOINT'];
    this.sse = options.sse ?? process.env['AWS_S3_SSE'] ?? 'AES256';
    if (!this.bucket) throw new Error('AWS_S3_BUCKET is required for the s3 storage provider');
    this.client = new S3Client({
      region: options.region ?? process.env['AWS_REGION'] ?? 'us-east-1',
      ...(this.endpoint && { endpoint: this.endpoint, forcePathStyle: true }),
    });
  }

  locationId(): string {
    return locationFingerprint('s3', `${this.endpoint ?? 'aws'}\0${this.bucket}`);
  }

  exactDeleteCapability(): StorageExactDeleteCapability {
    // Native AWS documents DeleteObject If-Match/VersionId. S3-compatible
    // endpoints (including R2) do not inherit that guarantee merely by using
    // the protocol; verification intake stays closed until conformance exists.
    return this.endpoint ? 'UNSUPPORTED' : 'ATOMIC_GENERATION';
  }

  reserveKey(input: { filename: string; folder: string }): { url: string } {
    const folder = safeFolder(input.folder);
    const ext = path.extname(path.basename(input.filename)) || '.bin';
    return { url: `${folder}/${nanoid(16)}${ext}` };
  }

  async upload(input: StorageUploadInput): Promise<StoredObjectReference> {
    const safe = sanitizeForStorage(input);
    const folder = safeFolder(safe.folder);
    const key = canonicalReservedKey(
      safe.fileKey ?? this.reserveKey({ filename: safe.filename, folder }).url,
      folder,
    );
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: safe.buffer,
        ContentType: safe.mimeType,
        IfNoneMatch: '*',
        // R2 rejects unknown SSE headers; only send for native S3 (no endpoint).
        ...(!this.endpoint && { ServerSideEncryption: this.sse as 'AES256' }),
      }),
    );
    const objectVersion = result.VersionId
      ? encodeProviderVersion('version', result.VersionId)
      : result.ETag
        ? encodeProviderVersion('etag', result.ETag)
        : null;
    if (!objectVersion) throw new Error('Storage provider did not return an immutable object generation');
    return { url: key, objectVersion };
  }

  async getSignedUrl(fileKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS, objectVersion?: string): Promise<string> {
    const generation = objectVersion ? decodeProviderVersion(objectVersion) : {};
    if (objectVersion && !generation) throw new Error('Invalid S3 object generation');
    return presignS3(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: fileKey, ...generation }),
      { expiresIn: ttlSeconds },
    );
  }

  async delete(fileKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey }));
  }

  async deleteExact(fileKey: string, objectVersion: string): Promise<void> {
    const generation = decodeProviderVersion(objectVersion);
    if (!generation) throw new Error('Invalid S3 object generation');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fileKey, ...generation }));
  }

  async getObject(fileKey: string, objectVersion?: string, options: StorageReadOptions = {}): Promise<Buffer> {
    const generation = objectVersion ? decodeProviderVersion(objectVersion) : {};
    if (objectVersion && !generation) throw new Error('Invalid S3 object generation');
    const maxBytes = readLimit(options);
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: fileKey, ...generation }),
      { abortSignal: options.signal },
    );
    if (typeof res.ContentLength === 'number' && res.ContentLength > maxBytes) {
      (res.Body as ReadableObjectBody | undefined)?.destroy?.();
      throw new StorageObjectTooLargeError(maxBytes);
    }
    if (!res.Body) throw new Error('Storage provider returned an empty object body');
    return collectBoundedBody(res.Body as ReadableObjectBody, options);
  }

  async probe(fileKey: string, objectVersion?: string): Promise<StorageProbeResult> {
    const generation = objectVersion ? decodeProviderVersion(objectVersion) : {};
    if (objectVersion && !generation) return 'MISMATCH';
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fileKey, ...generation }));
      return 'PRESENT';
    } catch (error) {
      const code = errorCode(error);
      if (code === 'PreconditionFailed' || code === '412') return 'MISMATCH';
      return code === 'NoSuchKey' || code === 'NoSuchVersion' || code === 'NotFound' || code === '404'
        ? 'ABSENT'
        : 'UNKNOWN';
    }
  }

  async identifyGeneration(fileKey: string): Promise<StorageGenerationIdentification> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fileKey }));
      const objectVersion = result.VersionId
        ? encodeProviderVersion('version', result.VersionId)
        : result.ETag
          ? encodeProviderVersion('etag', result.ETag)
          : null;
      return objectVersion ? { status: 'PRESENT', objectVersion } : { status: 'UNKNOWN' };
    } catch (error) {
      const code = errorCode(error);
      return {
        status: code === 'NoSuchKey' || code === 'NoSuchVersion' || code === 'NotFound' || code === '404'
          ? 'ABSENT'
          : 'UNKNOWN',
      };
    }
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

/**
 * Resolve an immutable location identity across bucket/endpoint/base-dir
 * rotations. Historical locations are operator-configured without embedding
 * credentials; S3 adapters continue to use the process credential chain.
 */
export function getStorageProviderForLocation(locationId: string): StorageProvider | null {
  const current = getStorageProvider();
  if (current.locationId() === locationId) return current;
  const raw = process.env['STORAGE_LEGACY_LOCATIONS_JSON'];
  if (!raw || raw.length > 32_768) return null;
  let configs: unknown;
  try {
    configs = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(configs) || configs.length > 32) return null;
  for (const value of configs) {
    if (!value || typeof value !== 'object') continue;
    const config = value as Record<string, unknown>;
    let provider: StorageProvider | null = null;
    if (config['kind'] === 'local' && typeof config['baseDir'] === 'string' && config['baseDir'].length > 0) {
      provider = new LocalStorageProvider({ baseDir: config['baseDir'] });
    } else if (config['kind'] === 's3' && typeof config['bucket'] === 'string' && config['bucket'].length > 0) {
      provider = new S3StorageProvider({
        bucket: config['bucket'],
        ...(typeof config['endpoint'] === 'string' ? { endpoint: config['endpoint'] } : {}),
        ...(typeof config['region'] === 'string' ? { region: config['region'] } : {}),
        ...(typeof config['sse'] === 'string' ? { sse: config['sse'] } : {}),
      });
    }
    if (provider?.locationId() === locationId) return provider;
  }
  return null;
}
