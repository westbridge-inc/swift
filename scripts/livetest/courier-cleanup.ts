import { FIXTURE_PNG, POST, upload, type Res, type Session } from './client.js';

interface CourierLeg {
  id: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  courierPayer?: string | null;
}

const recoveryRequired = (message: string): Res => ({
  status: 409, ok: false,
  json: { success: false, error: { code: 'JOURNEY_COURIER_RECOVERY_REQUIRED', message } },
  text: message,
});

/** Synthetic journey cleanup only; execution still requires an authorized test target. */
export async function completeCourierFixture(session: Session, leg: CourierLeg, gps: { lat: number; lng: number }): Promise<Res> {
  if (!['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(leg.status)) {
    return recoveryRequired('The parcel needs its custody or return workflow.');
  }
  const recipientCash = leg.paymentMethod === 'CASH' && leg.paymentStatus === 'PENDING' && leg.courierPayer === 'RECIPIENT';
  if (leg.paymentStatus !== 'CAPTURED' && !recipientCash) {
    return recoveryRequired('The fee has not been captured; cleanup cannot invent a sender collection.');
  }
  const photo = await upload(`/courier/order/${leg.id}/proof-photo`, session.token,
    { name: 'journey-proof.png', type: 'image/png', bytes: FIXTURE_PNG });
  if (!photo.ok) return photo;
  const proofPhotoUrl = photo.json?.data?.url;
  if (typeof proofPhotoUrl !== 'string' || !proofPhotoUrl) {
    return recoveryRequired('The upload did not return an issued proof.');
  }
  return POST(`/courier/order/${leg.id}/proof`, {
    proofPhotoUrl, ...(recipientCash ? { outcome: 'paid', gps } : {}),
  }, session.token);
}
