'use client';

import { useEffect, useState, type ComponentType } from 'react';

type Note = ComponentType<{ className?: string }>;

/**
 * [OPEN-EARLY · size budget] The partner consoles and the sign-up page fetch the pre-launch partner note
 * (components/prelaunch-partner-note.tsx) once the page is up: it is one sentence, shown only before launch, so it
 * never rides in their first load. If the fetch fails, nothing shows (the note is never needed to act).
 */
export function LazyPrelaunchPartnerNote({ className }: { className?: string }) {
  const [Loaded, setLoaded] = useState<Note | null>(null);
  useEffect(() => {
    let live = true;
    import('./prelaunch-partner-note').then((m) => { if (live) setLoaded(() => m.PrelaunchPartnerNote); }, () => undefined);
    return () => { live = false; };
  }, []);
  return Loaded ? <Loaded className={className} /> : null;
}
