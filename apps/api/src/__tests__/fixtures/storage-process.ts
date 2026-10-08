// Separate synthetic API/worker lifetimes. No services or environment files.
import { createHash } from 'node:crypto';
import { LocalStorageProvider } from '../../providers/storage/storage-provider';

async function main() {
  const storage = new LocalStorageProvider();
  const [operation, key] = process.argv.slice(2);
  if (operation === 'upload') {
    const { url } = await storage.upload({ buffer: Buffer.from('synthetic private envelope bytes'), filename: 'fixture.enc', mimeType: 'application/octet-stream', folder: 'verification/synthetic-subject' });
    process.stdout.write(url);
  } else if (operation === 'read' && key) {
    process.stdout.write(createHash('sha256').update(await storage.getObject(key)).digest('hex'));
  } else if (operation === 'delete' && key) {
    await storage.delete(key);
  } else throw new Error('Unknown synthetic operation');
}
void main().catch(() => { process.exitCode = 1; });
