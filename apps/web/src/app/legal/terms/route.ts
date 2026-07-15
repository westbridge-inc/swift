import { redirect } from 'next/navigation';
import { LEGAL_URL } from '@/lib/api';

// One source of truth: the API hosts the legal pages; the site points at them.
export function GET() {
  redirect(LEGAL_URL('terms'));
}
