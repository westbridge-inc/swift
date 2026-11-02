import type { Metadata } from 'next';
import { Section } from '@/components/site';
import { DeletionReceiptView } from '@/components/account-deletion/deletion-receipt';

/**
 * [WEB-DELETE] Where the website lands after a person deletes their account. Public (the person is signed out by
 * then) and outside the pre-launch front door, but one person's moment, not search content: never indexed.
 */
export const metadata: Metadata = {
  title: 'Your Swift account',
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return <Section><div className="max-w-3xl"><DeletionReceiptView /></div></Section>;
}
