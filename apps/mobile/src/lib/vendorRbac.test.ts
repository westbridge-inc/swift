import { describe, it, expect } from 'vitest';
import { vendorSurfaceForRole } from './vendorRbac';

// Client mirror of the server's vendor role guards (apps/api vendor.routes.ts):
//   PUT /vendor/toggle-open, the self-delivery setting, and every /analytics/*
//   read require MANAGER; PUT /vendor/toggle-orders and GET /orders are open to
//   floor STAFF. The dashboard hides what the server would 403 so STAFF never
//   see a dead control or a misleading GYD 0 (an analytics 403 reads as empty
//   money). This pins that matrix so the UI and the API can't drift apart.

describe('vendorSurfaceForRole — client mirror of server vendor guards', () => {
  it('STAFF: runs the live board only — no money, no manager controls', () => {
    const s = vendorSurfaceForRole('STAFF');
    expect(s.canToggleOrders).toBe(true); // pause/resume the queue + read /orders
    expect(s.canSeeMoney).toBe(false); // /analytics/* is MANAGER — would 403
    expect(s.canToggleOpen).toBe(false); // PUT /vendor/toggle-open is MANAGER
    expect(s.canSetSelfDelivery).toBe(false); // self-delivery setting is MANAGER
  });

  it('MANAGER: full operating surface', () => {
    const s = vendorSurfaceForRole('MANAGER');
    expect(s).toEqual({ canToggleOrders: true, canSeeMoney: true, canToggleOpen: true, canSetSelfDelivery: true });
  });

  it('OWNER: full operating surface', () => {
    const s = vendorSurfaceForRole('OWNER');
    expect(s).toEqual({ canToggleOrders: true, canSeeMoney: true, canToggleOpen: true, canSetSelfDelivery: true });
  });

  it('unknown/absent role defaults to least privilege (treated as STAFF)', () => {
    expect(vendorSurfaceForRole(null)).toEqual(vendorSurfaceForRole('STAFF'));
    expect(vendorSurfaceForRole(undefined)).toEqual(vendorSurfaceForRole('STAFF'));
  });
});
