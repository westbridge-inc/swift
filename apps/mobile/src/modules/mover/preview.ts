import { useCallback } from 'react';
import { DRIVER_VEHICLE_KINDS, type VehicleKind } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useMoverPreview, type MoverPreviewKind } from '../../stores/moverPreview';

/**
 * The earner preview's doors and words [owner, 1 Oct 2026]: a delivery rider
 * or a taxi driver whose documents are still being checked opens "Preview your
 * dashboard" from the document area and looks around their own dashboard with
 * sample numbers. Leaving goes back the way they came: to their documents, or
 * — for someone who opened "Preview the driver app" on the welcome screen — to
 * the welcome screen.
 */
export const PREVIEW_COPY = {
  entry: 'Preview your dashboard',
  entryCaption: {
    RIDER: 'See the delivery rider dashboard with sample numbers.',
    DRIVER: 'See the taxi driver dashboard with sample numbers.',
  } satisfies Record<MoverPreviewKind, string>,
  notice: 'This is a preview with sample numbers.',
  fromDocuments: 'Finish your documents to start earning.',
  fromWelcome: 'Sign up to start earning.',
  backToDocuments: 'Back to my documents',
  exit: 'Exit preview',
} as const;

/** The face a vehicle registers: passenger vehicles provision a taxi Driver,
 *  everything else a delivery Rider (the server's rule, config/vehicle-classes:
 *  a vehicle with a ride class is a Driver's). */
export function previewFaceForVehicle(vehicle: VehicleKind): MoverPreviewKind {
  return DRIVER_VEHICLE_KINDS.includes(vehicle) ? 'DRIVER' : 'RIDER';
}

/** Leave the preview the way it was entered. From the documents the mover app
 *  stays open, so the stack (reset by its preview key) lands on the documents;
 *  from the welcome screen the intent is cleared, back to the welcome. */
export function useLeaveMoverPreview() {
  const fromDocuments = useMoverPreview((s) => s.origin) === 'documents';
  const setIntent = useAuthStore((s) => s.setIntent);
  const leave = useCallback(() => {
    const { origin, exitPreview } = useMoverPreview.getState();
    exitPreview();
    if (origin !== 'documents') setIntent(null);
  }, [setIntent]);
  return { fromDocuments, leave };
}
