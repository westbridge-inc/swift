import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// StorageProvider — hard rule 4: swappable interface. An S3-class adapter
// slots in later; routes validate size/type, the provider only stores bytes.
// ---------------------------------------------------------------------------

export interface StorageProvider {
  upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }>;
}

/** Local-disk adapter for dev/test. Files land under UPLOAD_DIR (gitignored). */
export class LocalStorageProvider implements StorageProvider {
  private baseDir = process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'uploads');

  async upload(input: { buffer: Buffer; filename: string; mimeType: string; folder: string }): Promise<{ url: string }> {
    const ext = path.extname(input.filename) || '.bin';
    const name = `${nanoid(16)}${ext}`;
    const dir = path.join(this.baseDir, input.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), input.buffer);
    return { url: `/uploads/${input.folder}/${name}` };
  }
}

/** Provider selection is config, not code. */
export function getStorageProvider(): StorageProvider {
  const provider = process.env['STORAGE_PROVIDER'] ?? 'local';
  switch (provider) {
    case 'local':
      return new LocalStorageProvider();
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: ${provider}`);
  }
}
