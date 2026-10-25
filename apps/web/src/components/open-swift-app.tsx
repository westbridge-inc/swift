/** Opens the installed app using apps/mobile/app.config.ts's registered scheme.
 * No taxi deep-link route or store listing is configured; choose Taxi in-app. */
export function OpenSwiftApp() {
  return (
    <div className="flex flex-col items-start gap-2">
      <a href="swift://" className="sw-btn sw-btn-ink">
        Open Swift app
      </a>
      <p className="text-[13px] leading-[18px] text-[var(--swift-muted)]">
        This opens Swift if it is installed on your phone. Choose Taxi in the app.
      </p>
    </div>
  );
}
