/** Opens the installed app using apps/mobile/app.config.ts's registered scheme.
 * No taxi deep-link route or store listing is configured; choose Taxi in-app. */
export function OpenSwiftApp() {
  return (
    <div className="space-y-2">
      <a href="swift://" className="inline-block rounded-full bg-[var(--swift-red)] px-5 py-3 font-semibold text-white">
        Open Swift app
      </a>
      <p className="text-sm text-[var(--swift-muted)]">
        This opens Swift if it is installed on your phone. Choose Taxi in the app.
      </p>
    </div>
  );
}
