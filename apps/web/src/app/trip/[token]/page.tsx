import type { Metadata } from 'next';
import { TripShareClient } from './trip-share-client';

// Trip Share public page (safety spec §6): a recipient with NO app and no
// account follows a live trip in any browser over 3G. Server truth only —
// the client polls the public read every 5s; nothing on this page animates
// a promise the server didn't make. Weight budget <300KB: no map library,
// the live pin rides an OpenStreetMap embed iframe.

export const metadata: Metadata = {
  title: 'Live trip — Swift',
  robots: { index: false, follow: false }, // tokenized page — never indexed
};

export default async function TripSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <TripShareClient token={token} />;
}
