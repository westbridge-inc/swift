import type { Metadata } from 'next';
import { site, SITE_ORIGIN } from '@/site.config';

/**
 * [Q36] The shell for the site's own policy pages: refunds and cancellations,
 * and delivery. They are NOT the DGP-1 legal documents (terms, privacy, child
 * safety), which are authored once in the API and snapshotted into the site
 * with a version that consent records point at — see legal-document.tsx.
 * These pages explain, in plain words, how the product works today; each
 * sentence is traced to the code in the lane's evidence. They carry their own
 * "last updated" date rather than borrowing the legal version they are not.
 */

export function policyMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: `${SITE_ORIGIN}${path}` },
    openGraph: { title: `${title} — ${site.tradeName}`, description, url: `${SITE_ORIGIN}${path}`, siteName: site.tradeName, type: 'article' },
    robots: { index: true, follow: true },
  };
}

export function PolicyDocument({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-14 md:py-20">
      <header className="border-b border-[var(--swift-border)] pb-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-muted)]">{site.tradeName} policy</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[var(--swift-ink)] md:text-4xl">{title}</h1>
        <p className="mt-4 text-sm text-[var(--swift-muted)]">
          Last updated <span className="font-medium text-[var(--swift-ink)]">{updated}</span>
        </p>
      </header>
      <div className="legal-prose mt-10">{children}</div>
      <div className="mt-14 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-subtle)] p-6 text-sm text-[var(--swift-muted)]">
        <p>
          Questions about this policy:{' '}
          <a className="font-medium text-[var(--swift-red)] underline underline-offset-2" href={`mailto:${site.supportEmail}`}>
            {site.supportEmail}
          </a>{' '}
          or{' '}
          <a className="font-medium text-[var(--swift-red)] underline underline-offset-2" href={`tel:${site.phone.replace(/[^\d+]/g, '')}`}>
            {site.phone}
          </a>
          . {site.tradeName} is a trade name of{' '}
          <strong className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</strong>, {site.registeredCity},{' '}
          {site.country}.
        </p>
      </div>
    </article>
  );
}
