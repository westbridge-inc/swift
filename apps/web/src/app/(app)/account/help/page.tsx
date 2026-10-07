import { AccountBoundary } from '@/components/account/account-frame';
import { Help, type HelpTopic } from '@/components/account/help';

// [DOCS-1] A partner asking about a document review arrives with the topic and
// the document named (never the reviewer's words — those stay on their page).
const TOPICS = new Set<HelpTopic>(['VENDOR', 'MOVER']);
const DOCUMENT = /^[a-z0-9_-]{2,60}$/;

export default async function Page({ searchParams }: { searchParams: Promise<{ orderId?: string; topic?: string; document?: string }> }) {
  const { orderId, topic, document } = await searchParams;
  const order = typeof orderId === 'string' ? orderId.slice(0, 64) : '';
  const about = typeof topic === 'string' && TOPICS.has(topic as HelpTopic) ? (topic as HelpTopic) : undefined;
  const doc = typeof document === 'string' && DOCUMENT.test(document) ? document : undefined;
  const query = new URLSearchParams({ ...(order ? { orderId: order } : {}), ...(about ? { topic: about } : {}), ...(doc ? { document: doc } : {}) }).toString();
  return (
    <AccountBoundary path={`/account/help${query ? `?${query}` : ''}`}>
      <Help key={query} orderId={order} topic={about} document={doc} />
    </AccountBoundary>
  );
}
