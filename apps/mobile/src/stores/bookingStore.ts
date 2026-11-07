import { create } from 'zustand';

export type ServiceVisitMode = 'AT_BUSINESS' | 'MOBILE';

interface PendingAppointment {
  slotStart: string; // ISO — validated server-side at checkout
  mode?: ServiceVisitMode; // only meaningful when the business offers BOTH
  /** [BOOK-S6a] The slots answer said this listing confirms cash bookings at
   *  once (switch on + the business's setting). Drives the cart button's words
   *  only; never sent to checkout, which is the judge. */
  instant?: boolean;
}

interface BookingState {
  /** Chosen slot per APPOINTMENT cart item, keyed by itemId. Session-scoped
   *  on purpose: a slot is a moment in time — never persist a stale one. */
  appointments: Record<string, PendingAppointment>;
  setAppointment: (itemId: string, appt: PendingAppointment) => void;
  removeAppointment: (itemId: string) => void;
  clear: () => void;
}

export const useBookingStore = create<BookingState>((set) => ({
  appointments: {},
  setAppointment: (itemId, appt) =>
    set((s) => ({ appointments: { ...s.appointments, [itemId]: appt } })),
  removeAppointment: (itemId) =>
    set((s) => {
      const next = { ...s.appointments };
      delete next[itemId];
      return { appointments: next };
    }),
  clear: () => set({ appointments: {} }),
}));
