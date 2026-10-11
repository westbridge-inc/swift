import { serveStorePhoto } from '@/lib/store-photo-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = serveStorePhoto;
