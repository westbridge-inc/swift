'use client';

import { useState } from 'react';
import { feeMoney, type FeeCheckoutSession, type WeekOption } from '@/lib/weekly-fee';

/**
 * [owner 6 Nov 2026] "How many weeks?" on the weekly-fee page, and its Pay button: 1 to 4 weeks, each only when the
 * server says it fits, the button labelled with the chosen amount. The page loads this only when there is more than
 * one choice (perf budget), so its words are not in the first load. A choice gone stale (the server offers fewer
 * weeks now) falls back to one week.
 */
export default function WeeklyFeeWeeks({ choices, disabled, session }: { choices: WeekOption[]; disabled: boolean; session: FeeCheckoutSession }) {
  const [weeks, setWeeks] = useState(1);
  const chosen = choices.find((c) => c.weeks === weeks) ?? choices[0]!;
  return <>
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">How many weeks?</legend>
      <p className="text-sm text-[var(--swift-muted)]">You can pay up to four weeks ahead.</p>
      <div className="grid grid-cols-2 gap-2">
        {choices.map((c) => <label key={c.weeks} className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 text-sm ${chosen.weeks === c.weeks ? 'border-[var(--swift-red)] bg-[var(--swift-red-50)]' : 'border-black/10'}`}>
          <input type="radio" name="mmg-weeks" className="sr-only" value={c.weeks} checked={chosen.weeks === c.weeks} onChange={() => setWeeks(c.weeks)} />
          <span className="font-semibold">{c.weeks === 1 ? '1 week' : `${c.weeks} weeks`}</span>
          <span className="text-[var(--swift-muted)]">{feeMoney(c.amountGyd)}</span>
        </label>)}
      </div>
    </fieldset>
    <button disabled={disabled} onClick={() => void session.pay(chosen.weeks)} className="mt-auto inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">
      {`Pay ${feeMoney(chosen.amountGyd)} with MMG`}
    </button>
  </>;
}
