import type { AnchorHTMLAttributes, ReactNode } from 'react';

type TestLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  children: ReactNode;
  href: string | { pathname?: string };
};

export default function TestLink({ children, href, ...props }: TestLinkProps) {
  const resolvedHref = typeof href === 'string' ? href : (href.pathname ?? '');
  return (
    <a href={resolvedHref} {...props}>
      {children}
    </a>
  );
}
