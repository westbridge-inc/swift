/**
 * [O-1 · owner 24 Oct 2026] The Swift call bridge's voice provider, behind ONE
 * small interface, so a second carrier route (or in-app calling later) can drop
 * in without touching the bridge's rules. Twilio is adapter #1 (twilio-voice.ts).
 *
 * The bridge never hands a provider anything it does not need to place one call:
 * the number to ring, Swift's caller ID, and the URLs of Swift's own steps. The
 * provider never stores a session, decides a party, or picks a number.
 */

/** A provider webhook as it arrived: the URL it was sent to and its form fields. */
export interface ProviderWebhook {
  url: string;
  fields: Record<string, string[]>;
  signature: unknown;
}

/** What a webhook says, in the bridge's words. */
export interface ProviderEvent {
  /** The key the person pressed at a "Press 1" prompt; null when none. */
  digits: string | null;
  /** The whole call's state on a status callback (provider words, lower case). */
  callStatus: string | null;
  /** How the second leg ended (on the dial-done step). */
  dialStatus: string | null;
  /** Seconds the provider billed for the leg the event is about. */
  durationSeconds: number | null;
  /** The provider's id for the call the event is about. */
  providerCallId: string | null;
}

/** One step of a bridged call, provider-neutral. Rendered by the adapter. */
export type CallStep =
  /** "Press 1": only a pressed 1 goes on to `next`; silence or another key hears `noInput` and the call ends. */
  | { verb: 'confirm'; prompt: string; next: string; noInput: string }
  /** Ring the other party with Swift's caller ID; `screen` runs on their phone before they are connected. */
  | { verb: 'dial'; say: string; to: string; callerId: string; screen: string; done: string; ringSeconds: number; limitSeconds: number }
  /** The screened party pressed 1: connect them. */
  | { verb: 'connect' }
  /** End this leg, optionally saying something first. */
  | { verb: 'hangup'; say?: string };

export interface PlaceCallInput {
  to: string;
  callerId: string;
  /** Swift's first step, run when the person answers. */
  answerUrl: string;
  /** Where the provider reports the call's progress and its end. */
  statusUrl: string;
  ringSeconds: number;
  limitSeconds: number;
}

export interface CallProvider {
  readonly name: string;
  /** Ring the person who asked for the call. Resolves with the provider's id for it. */
  placeCall(input: PlaceCallInput): Promise<{ providerCallId: string }>;
  /** Was this webhook really sent by the provider, to exactly this URL? */
  verify(hook: ProviderWebhook): boolean;
  /** Read a verified webhook. */
  read(fields: Record<string, string[]>): ProviderEvent;
  /** The step as the provider's instruction document. */
  render(step: CallStep): { contentType: string; body: string };
}
