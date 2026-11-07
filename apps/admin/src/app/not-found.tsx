import Link from 'next/link';

// [ADMIN-AUDIT S4-2] An unknown address inside the console: Next's default 404 brought its own h1 (a second one under
// the shell's header) and no way back. It says what happened, in the console's words, with a door to Today.
export default function NotFound() {
  return (
    <div className="mc-page">
      <section className="mc-card">
        <h2 className="mc-section-title">There is no page at this address</h2>
        <p className="mc-muted mt-1.5">The link may be old or mistyped. Everything is reachable from the menu.</p>
        <div className="mc-actions">
          <Link href="/dashboard" className="mc-btn mc-btn-primary">Go to Today</Link>
        </div>
      </section>
    </div>
  );
}
