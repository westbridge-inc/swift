import type { Metadata } from 'next';
import { TrackClient } from './track-client';

// Parcel tracking public page [B9]: the courier engine has served
// GET /courier/track/:token since launch and NOTHING ever linked to it — the
// recipient's half of Send simply had no page. Mirrors /trip/[token]: a
// recipient with NO app and no account follows the parcel in any browser over
// 3G. Server truth only — the client polls the public read every 5s; nothing
// here animates a promise the server didn't make. No map library; the live
// pin rides an OpenStreetMap embed iframe.

export const metadata: Metadata = {
  title: 'Track a parcel — Swift',
  robots: { index: false, follow: false }, // tokenized page — never indexed
};

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <TrackClient token={token} />;
}
