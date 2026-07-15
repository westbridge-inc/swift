import { redirect } from 'next/navigation';
import { LEGAL_URL } from '@/lib/api';

export function GET() {
  redirect(LEGAL_URL('privacy'));
}
