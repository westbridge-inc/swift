import { useEffect } from 'react';
import type { FeeState, SignupPricing } from '@/lib/signup-fee';

/**
 * [Row 628] Test support for the sign-up page's weekly fee block.
 *
 * `WeeklyFee` stands in for the block (app/signup/weekly-fee.tsx) in the sign-up tests that are
 * about something else (roles, the store pin, the agreement): it says what an API older than the
 * tick says — nothing to tick, nothing sent — so those tests keep testing their own subject. The
 * block itself, through the real page, is tested in app/signup/weekly-fee.test.tsx.
 */
export function WeeklyFee({ onChange }: { onChange: (_state: FeeState) => void }) {
  useEffect(() => { onChange({ ask: null }); }, [onChange]);
  return null;
}

/** The server's v1 fee words, as GET /auth/pricing serves them (apps/api partner/weekly-fee-ack.ts). */
export const FEE_TERMS_V1 = {
  version: 'v1',
  items: [
    { heading: 'What it covers', text: 'The Swift app and its tools for your work. Swift takes no commission: you keep 100% of your sales, fares, delivery fees and tips.' },
    { heading: 'When it starts', text: 'Nothing is paid at sign-up. The weekly fee starts only after Swift approves you and you go live, and after your free trial if you get one.' },
    { heading: 'How you pay', text: 'In the Swift app, on MMG’s checkout page, one week at a time. Paying by card is not offered yet.' },
    { heading: 'If the price changes', text: 'Swift tells you in the app at least 14 days before. A new price applies only from your first weekly fee due after that, never to a week you have already paid.' },
  ],
  tick: 'I understand the weekly fee.',
};

/** A Guyana price list with made-up amounts (each vehicle and business type its own). */
export const SIGNUP_PRICING: SignupPricing = {
  currencyCode: 'GYD',
  currencySymbol: '$',
  movers: [
    { vehicleType: 'MOTORCYCLE', rate: 6000 },
    { vehicleType: 'BICYCLE', rate: 5000 },
    { vehicleType: 'CAR', rate: 8000 },
    { vehicleType: 'WAGON_CAR', rate: 8500 },
  ],
  vendors: { service: 7000, catalogue: [{ minItems: 0, rate: 9000 }, { minItems: 1000, rate: 20000 }] },
  feeTerms: FEE_TERMS_V1,
};
