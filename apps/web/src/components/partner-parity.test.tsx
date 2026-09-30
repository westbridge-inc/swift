import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { clearSession } from '@/lib/auth';
import { DocumentChecklist } from './document-checklist';
import { AppDetails } from './app-details';
import { StoreDocuments } from './store-documents';
import { site } from '@/site.config';
import packageInfo from '../../package.json';
import type { ChecklistRole } from '@/lib/verification';
import DocumentsPage from '@/app/portal/documents/page';

beforeEach(() => clearSession());
const result = (checklist: string[], extra = {}) => ({ body: { success: true, data: { checklist, missing: checklist, documents: [], roleVerified: false, ...extra } } });

describe('phone document checklist parity', () => {
  it.each([
    ['STORE', undefined, ['owner_national_id', 'business_registration']],
    ['RESTAURANT', undefined, ['owner_national_id', 'food_handler_cert']],
    ['SUPERMARKET', undefined, ['owner_national_id', 'storefront_photo']],
    ['SERVICE', undefined, ['owner_national_id', 'police_clearance']],
    ['SERVICE_PROVIDER', undefined, ['national_id', 'trade_licence']],
    ['MOVER', 'BICYCLE', ['national_id', 'police_clearance']],
    ['MOVER', 'MOTORCYCLE', ['national_id', 'drivers_licence', 'vehicle_registration']],
    ['MOVER', 'CAR', ['national_id', 'drivers_licence', 'hire_car_permit']],
    ['MOVER', 'VAN', ['national_id', 'vehicle_insurance']],
  ] as const)('requests the canonical %s / %s requirements', async (role, vehicleType, checklist) => {
    const api = mockApi(({ url }) => {
      expect(url.pathname).toBe('/api/v1/verification/status');
      expect(url.searchParams.get('role')).toBe(role);
      expect(url.searchParams.get('vehicleType')).toBe(vehicleType ?? null);
      return result([...checklist]);
    });
    render(<DocumentChecklist role={role as ChecklistRole} {...(vehicleType ? { vehicleType } : {})} />);
    const region = screen.getByRole('region', { name: 'Required documents' });
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(checklist.length));
    expect(api).toHaveBeenCalledTimes(1);
    if (vehicleType === 'BICYCLE') {
      expect(within(region).getByText('Police Clearance Certificate')).toBeTruthy();
      expect(within(region).queryByText(/licence|insurance|registration/i)).toBeNull();
    }
    expect(within(region).getByText(/Upload these in the Swift phone app/)).toBeTruthy();
  });

  it('never keeps car requirements visible while switching to a bicycle', async () => {
    let resolveBicycle!: () => void;
    mockApi(async ({ url }) => {
      if (url.searchParams.get('vehicleType') === 'BICYCLE') await new Promise<void>((resolve) => { resolveBicycle = resolve; });
      return result(url.searchParams.get('vehicleType') === 'CAR' ? ['vehicle_insurance'] : ['national_id']);
    });
    const view = render(<DocumentChecklist role="MOVER" vehicleType="CAR" />);
    await screen.findByText('Vehicle Insurance');
    view.rerender(<DocumentChecklist role="MOVER" vehicleType="BICYCLE" />);
    expect(screen.queryByText('Vehicle Insurance')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Checking');
    resolveBicycle();
    await screen.findByText('National ID');
    expect(screen.queryByText('Vehicle Insurance')).toBeNull();
  });

  it('shows a retry on failure and never claims no documents are required', async () => {
    let fail = true;
    mockApi(() => fail ? { status: 503, body: { success: false } } : result(['national_id']));
    render(<DocumentChecklist role="MOVER" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try documents again' }));
    await screen.findByText('National ID');
  });

  it('explains service-provider trade requirements when the API cannot supply a checklist', async () => {
    mockApi(() => result([], { categoryUnavailable: true }));
    render(<DocumentChecklist role="SERVICE_PROVIDER" />);
    expect(await screen.findByText(/Service checks pending/)).toBeTruthy();
    expect(screen.queryByText('Approved')).toBeNull();
  });

  it('uses the selected store type in the dashboard', async () => {
    mockApi(({ url }) => url.pathname === '/api/v1/vendor/stores'
      ? { body: { success: true, data: { stores: [{ id: 'store-fixture', vendorType: 'RESTAURANT' }], selectedId: 'store-fixture', myRole: 'OWNER' } } }
      : (expect(url.searchParams.get('role')).toBe('RESTAURANT'), result(['food_handler_cert'])));
    renderWithQuery(<StoreDocuments />);
    await screen.findByText("Food Handler's Certificate");
  });

  it('does not present a staff member’s identity documents as the store owner’s requirements', async () => {
    const api = mockApi(() => ({ body: { success: true, data: { stores: [{ id: 'staff-store', vendorType: 'STORE' }], selectedId: 'staff-store', myRole: 'MANAGER' } } }));
    renderWithQuery(<StoreDocuments />);
    await screen.findByText('The store owner manages the required documents in their Swift account.');
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Required documents' })).toBeNull();
  });

  it('lets the server select the saved vehicle in the upload portal, including driver-only accounts', async () => {
    const api = mockApi(({ url }) => {
      expect(url.pathname).toBe('/api/v1/verification/status');
      expect(url.searchParams.get('role')).toBe('MOVER');
      expect(url.searchParams.has('vehicleType')).toBe(false);
      return result(['national_id', 'police_clearance'], { vehicleType: 'BICYCLE' });
    });
    renderWithQuery(<DocumentsPage />);
    await screen.findByText('Police Clearance Certificate');
    expect(screen.queryByText(/Vehicle Insurance|Driver.s Licence/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Upload' })).toHaveLength(2);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

it('renders company, contact, legal and actual web version details', () => {
  render(<AppDetails />);
  expect(screen.getByText(site.legalEntityName)).toBeTruthy();
  expect(screen.getByText(site.address)).toBeTruthy();
  expect(screen.getByRole('link', { name: site.phone }).getAttribute('href')).toBe(`tel:${site.phone.replace(/\s/g, '')}`);
  expect(screen.getByRole('link', { name: site.supportEmail }).getAttribute('href')).toBe(`mailto:${site.supportEmail}`);
  expect(screen.getByText(`Swift web app · Version ${packageInfo.version}`)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Terms of service' }).getAttribute('href')).toBe('/legal/terms');
  expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/legal/privacy');
});
