import type { AnchorHTMLAttributes, ReactNode } from 'react';

type TestLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  children: ReactNode;
  prefetch?: boolean | null;
  href: string | { pathname?: string };
};

export default function TestLink({ children, href, prefetch, ...props }: TestLinkProps) {
  const resolvedHref = typeof href === 'string' ? href : (href.pathname ?? '');
  return (
    <a data-prefetch={prefetch == null ? undefined : String(prefetch)} href={resolvedHref} {...props}>
      {children}
    </a>
  );
}
