import { redirect } from 'next/navigation';

/** Preserve indexed plural links while making singular /store the one checkout surface. */
export default async function LegacyStorefrontPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/store/${encodeURIComponent(slug)}`);
}
