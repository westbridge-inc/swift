import type { Metadata } from 'next';
import { site, SITE_ORIGIN } from '@/site.config';
import { LEGAL_VERSION, LEGAL_LAST_UPDATED } from '@/legal/generated';

/**
 * The shell every legal document renders inside.  [SITE-1.1 Part 2]
 *
 * Both stores require these pages to be publicly reachable, versioned, and
 * readable without an account. This renders a snapshot committed to the repo
 * (see scripts/sync-legal.ts), so the page is fully static and survives an API
 * outage — which is the state Apple is most likely to hit during enrollment.
 *
 * The document HTML comes from DGP-1 and is inserted verbatim. The site styles
 * its presentation and supplies the heading, version and effective date; it
 * changes no legal word.
 */

export function legalMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: `${SITE_ORIGIN}${path}` },
    openGraph: {
      title: `${title} — Swift`,
      description,
      url: `${SITE_ORIGIN}${path}`,
      siteName: 'Swift',
      type: 'article',
    },
    robots: { index: true, follow: true },
  };
}

export function LegalDocument({ title, html }: { title: string; html: string }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-14 md:py-20">
      <header className="border-b border-[var(--swift-border)] pb-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-muted)]">
          Swift legal
        </p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[var(--swift-ink)] md:text-4xl">
          {title}
        </h1>
        {/* Versioned, per both stores' requirements. The machine version is the
            value stamped onto a user's consent record at signup, so a support
            question years from now can be answered with the exact words shown. */}
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-1 text-sm text-[var(--swift-muted)]">
          <div className="flex gap-2">
            <dt>Effective</dt>
            <dd className="font-medium text-[var(--swift-ink)]">
              <time dateTime={LEGAL_VERSION}>{LEGAL_LAST_UPDATED}</time>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt>Version</dt>
            <dd className="font-medium text-[var(--swift-ink)] tabular-nums">{LEGAL_VERSION}</dd>
          </div>
        </dl>
      </header>

      {/* eslint-disable-next-line react/no-danger -- DGP-1 document text, committed
          to the repo and drift-checked in CI. Not user input, never remote. */}
      <div className="legal-prose mt-10" dangerouslySetInnerHTML={{ __html: html }} />

      <footer className="mt-14 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-subtle)] p-6 text-sm text-[var(--swift-muted)]">
        <p>
          Swift is operated by{' '}
          <strong className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</strong>.
          Questions about this document:{' '}
          <a
            className="font-medium text-[var(--swift-red)] underline underline-offset-2"
            href={`mailto:${site.supportEmail}`}
          >
            {site.supportEmail}
          </a>
          .
        </p>
      </footer>
    </article>
  );
}
