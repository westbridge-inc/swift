/**
 * [R7 · GUARDRAILS §7(4) · owner 15 Oct 2026] A licence label says what happened and when: "Licence on file, checked
 * on [date]" — the day a person on our team checked it (the API's `licenceCheckedOn`). No date, no label: the app
 * never shows "Certified", "licensed" or "verified" for a credential nobody checked.
 */
export function licenceLabel(checkedOn: string | null | undefined): string | null {
  if (!checkedOn) return null;
  const at = new Date(checkedOn);
  if (Number.isNaN(at.getTime())) return null;
  const day = at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' });
  return `Licence on file, checked on ${day}`;
}
