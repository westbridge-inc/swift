import path from 'node:path';

/** Provider selection and key identity are shared by the adapter and its
 * authority census. S3/R2 keys are literal; applying filesystem normalization
 * to them would grant authority over a different object. */
export function storageProviderKind(): 'local' | 's3' | 'r2' {
  const kind = process.env['STORAGE_PROVIDER'] ?? 'local';
  if (kind === 'local' || kind === 's3' || kind === 'r2') return kind;
  throw new Error('Unsupported storage provider');
}

export function localStorageBaseDir(): string {
  return path.resolve(process.env['UPLOAD_DIR'] ?? path.join(process.cwd(), 'uploads'));
}

/** Exactly the local adapter's supported prefix/dot/separator equivalence.
 * This is for existing references; callers must still supply canonical keys. */
export function resolveLocalStorageKey(fileKey: string, baseDir = localStorageBaseDir()): string {
  const relative = fileKey.replace(/^\/?uploads\//, '');
  const full = path.resolve(baseDir, relative);
  if (fileKey.includes('\0') || (full !== baseDir && !full.startsWith(baseDir + path.sep))) {
    throw new Error('Invalid file key: path escapes the uploads directory');
  }
  return full;
}
