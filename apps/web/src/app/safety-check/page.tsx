import type { Metadata } from 'next';
import { SafetyCheckClient } from './safety-check-client';

// [WEB-TAXI · owner 21 Oct 2026] Trip Guardian's texted answer link. A rider
// the push could not reach (a website booking, a phone with push off) is
// texted /safety-check#<check>.<secret> and answers here WITHOUT signing in:
// a sign-in code would eat the check-in's deadline. The secret sits after the
// '#', so it never reaches a server or a log; this page sends it to the API
// only with the rider's answer. One ask's secret answers only that waiting
// check-in — the API says nothing else about the trip.

export const metadata: Metadata = {
  title: 'Safety check — Swift',
  robots: { index: false, follow: false }, // a bearer link — never indexed
};

export default function SafetyCheckPage() {
  return <SafetyCheckClient />;
}
