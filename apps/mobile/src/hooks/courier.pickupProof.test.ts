import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// [E16] A courier takes custody of a parcel with a pickup photo and a location,
// in the app too.
//
// The server refuses the bare "Picked up" tap for a courier (409
// PICKUP_PROOF_REQUIRED) and binds only the photo it issued, with GPS. If the
// app still sent the bare tap, every courier would be stuck at the pickup.
// These pin the seams that make the app do the right thing:
//
//   client: the pickup photo uploads to its own route; the confirmation posts
//           the issued url with a REQUIRED GPS fix
//   hook:   upload first, then the evidence fix, then the confirmation, with
//           the auth principal re-proved between the steps
//   screen: at the courier's pickup rung the button captures a photo and runs
//           the pickup proof, never the generic rider leg; the sender-pays
//           collect step still comes first
//
// Comments are stripped first so a phrase in a comment can never satisfy an
// assertion about code.
// ---------------------------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const COURIER = strip(readFileSync(new URL('./courier.ts', import.meta.url), 'utf8'));
const API = strip(readFileSync(new URL('../services/api.ts', import.meta.url), 'utf8'));
const SCREEN = strip(readFileSync(new URL('../modules/mover/screens/ActiveJobScreen.tsx', import.meta.url), 'utf8'));

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `anchor not found: ${start}`).toBeGreaterThan(-1);
  expect(to, `anchor not found: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('the client', () => {
  const courierApi = body(API, 'export const courierApi', '\n};');
  it('uploads the pickup photo to its own route, on the captured session', () => {
    expect(courierApi).toContain('uploadPickupProof: (id: string, form: FormData, session?: AuthSessionSnapshot)');
    expect(courierApi).toContain('`/courier/order/${id}/pickup-proof-photo`, form, capturedAuthConfig(session');
  });
  it('confirms pickup with the issued url and a GPS fix the type does not let it drop', () => {
    expect(courierApi).toContain('body: { proofPhotoUrl: string; gps: { lat: number; lng: number } }');
    expect(courierApi).toContain('`/courier/order/${id}/pickup-proof`, body, capturedAuthConfig(session)');
  });
});

describe('the pickup-proof hook', () => {
  const hook = body(COURIER, 'export function useCourierPickupProof', '\n}\n');
  it('uploads, then takes the evidence fix, then confirms with both', () => {
    const upload = hook.indexOf('courierApi.uploadPickupProof(orderId, form, initial)');
    const fix = hook.indexOf('const fix = await evidenceFix(owner)');
    const confirm = hook.indexOf('courierApi.pickupProof(orderId, { proofPhotoUrl: url, gps: fix.gps }, fix.current)');
    expect(upload).toBeGreaterThan(-1);
    expect(fix).toBeGreaterThan(upload);
    expect(confirm).toBeGreaterThan(fix);
  });
  it('re-proves the auth principal after the upload and after the confirmation', () => {
    const upload = hook.indexOf('courierApi.uploadPickupProof(');
    const reproved = hook.indexOf('requireAuthSessionForPrincipal(owner)', upload);
    expect(reproved).toBeGreaterThan(upload);
    expect(hook.lastIndexOf('requireAuthSessionForPrincipal(owner)')).toBeGreaterThan(hook.indexOf('courierApi.pickupProof('));
  });
  it('never falls back to the bare rider leg', () => {
    expect(hook).not.toContain('riderApi');
    expect(hook).not.toContain("'picked-up'");
  });
});

describe('the screen', () => {
  it("at a courier's pickup rung the button captures the pickup photo, before the generic leg can answer", () => {
    const courierPickup = SCREEN.indexOf("isCourier && riderStep(job)!.action === 'picked-up'");
    const genericLeg = SCREEN.indexOf('bigButton(riderStep(job)!.label, () => riderAct.mutate({ id: job.id, action: riderStep(job)!.action })');
    expect(courierPickup).toBeGreaterThan(-1);
    expect(genericLeg).toBeGreaterThan(courierPickup);
    expect(SCREEN.slice(courierPickup, genericLeg))
      .toContain("bigButton('Capture pickup photo & confirm pickup', captureCourierPickupProof, { loading: courierPickupProof.isPending, disabled: busy })");
  });
  it("the sender-pays collect step still stands before the parcel's pickup photo", () => {
    const collect = SCREEN.indexOf("senderFeeDue && atSender\n");
    const courierPickup = SCREEN.indexOf("isCourier && riderStep(job)!.action === 'picked-up'");
    expect(collect).toBeGreaterThan(-1);
    expect(courierPickup).toBeGreaterThan(collect);
  });
  it('the capture runs the camera and the pickup-proof mutation, never the rider leg', () => {
    const capture = body(SCREEN, 'const captureCourierPickupProof', 'const isMmgPaid');
    expect(capture).toContain('ImagePicker.requestCameraPermissionsAsync()');
    expect(capture).toContain('ImagePicker.launchCameraAsync({ quality: 0.6 })');
    expect(capture).toContain('courierPickupProof.mutate(');
    expect(capture).toContain('{ orderId: job.id, uri: shot.assets[0].uri, authSession: owner ?? undefined }');
    expect(capture).not.toContain('riderAct.mutate');
  });
  it('the screen is busy while the pickup proof runs', () => {
    expect(SCREEN).toContain('const courierPickupProof = useCourierPickupProof()');
    expect(SCREEN).toMatch(/const busy = [^;]*courierPickupProof\.isPending/);
  });
});
