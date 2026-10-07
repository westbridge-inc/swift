import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardAuthContinuation, flushAuthContinuation, rootRouteForAuthContinuation, type AuthContinuationDestination } from '../../../mobile/src/navigation/authContinuation';

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: false, wantsAuth: false, promptLogin: vi.fn() },
  params: {} as Record<string, any>,
  vendor: {} as Record<string, any>,
  slots: {} as Record<string, any>,
  mutate: vi.fn(), parentNavigate: vi.fn(), setParams: vi.fn(),
}));
vi.mock('../../../mobile/src/stores/authStore', () => ({ useAuthStore: () => state.auth }));
vi.mock('../../../mobile/src/hooks/customer', () => ({
  useVendor: () => state.vendor,
  useAddToCart: () => ({ mutate: state.mutate, isPending: false, isError: false }),
  useItemSlots: () => state.slots,
}));
vi.mock('../../../mobile/src/stores/bookingStore', () => ({ useBookingStore: (select: any) => select({ setAppointment: vi.fn() }) }));
vi.mock('../../../mobile/src/lib/images', () => ({ itemPhoto: () => null }));
vi.mock('../../../mobile/src/kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));
vi.mock('../../../mobile/node_modules/react-native', () => ({ Dimensions: { get: () => ({ width: 390 }) }, ScrollView: ({ children }: any) => <div>{children}</div>, View: ({ children }: any) => <div>{children}</div> }));
vi.mock('../../../mobile/node_modules/@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('../../../mobile/node_modules/react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('../../../mobile/node_modules/@react-navigation/native', () => ({
  useRoute: () => ({ params: state.params }),
  useNavigation: () => ({ goBack: vi.fn(), navigate: vi.fn(), getParent: () => ({ navigate: state.parentNavigate }), setParams: state.setParams }),
}));
vi.mock('../../../mobile/src/kit', () => ({
  Photo: () => null, Money: () => null, IconChip: () => null,
  LoadingBlock: () => <div>Loading item</div>, ErrorState: () => <div>Item unavailable</div>,
  T: ({ children }: any) => <span>{children}</span>,
  SectionHeader: ({ title }: any) => <h2>{title}</h2>,
  PopupCard: ({ children, visible }: any) => visible ? <div>{children}</div> : null,
  PopupTitle: ({ children }: any) => <h2>{children}</h2>,
  Chip: ({ label, onPress, selected }: any) => <button aria-pressed={selected} onClick={onPress}>{label}</button>,
  CircleChip: ({ label, onPress }: any) => <button onClick={onPress}>{label}</button>,
  PillButton: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  QtyStepper: ({ value, onInc }: any) => <button onClick={onInc}>Quantity {value}</button>,
  LabeledInput: ({ label, value, onChangeText }: any) => <input aria-label={label} value={value} onChange={(e) => onChangeText(e.target.value)} />,
}));

const item = { id: 'roti', name: 'Roti', basePrice: 800, stockQuantity: null, isAvailable: true, optionGroups: [
  { id: 'filling', name: 'Filling', maxSelect: 1, isRequired: true, options: [
    { id: 'pumpkin', name: 'Pumpkin', isDefault: true, isAvailable: true },
    { id: 'chickpea', name: 'Chickpea', isAvailable: true },
  ] },
] };
const vendor = { data: { name: 'Scanned Store', categories: [{ items: [item] }] }, isLoading: false, isError: false };
const path = new URL('../../../mobile/src/modules/shop/screens/MenuItemScreen.tsx', import.meta.url).pathname;
let MenuItemScreen: React.ComponentType;
beforeAll(async () => { ({ MenuItemScreen } = await import(path)); });
beforeEach(() => {
  discardAuthContinuation();
  vi.clearAllMocks();
  state.params = { vendorId: 'scanned-store', itemId: 'roti' };
  state.vendor = vendor;
  state.slots = { data: { slots: [] } };
  state.auth.isAuthenticated = false;
  state.auth.wantsAuth = false;
  state.auth.promptLogin.mockImplementation(() => { state.auth.wantsAuth = true; });
  state.setParams.mockImplementation(params => { state.params = { ...state.params, ...params }; });
});

describe('guest item Add survives sign-in on the scanned store', () => {
  it.each([false, true])('preserves choices and one Add through cold-cache login, wantsAuth=%s', async wantsAuth => {
    state.auth.wantsAuth = wantsAuth;
    const guest = render(<MenuItemScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Chickpea/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Quantity 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    expect(state.auth.promptLogin).toHaveBeenCalledOnce();
    expect(state.parentNavigate.mock.calls).toEqual(wantsAuth ? [['Auth']] : []);
    expect(state.mutate).not.toHaveBeenCalled();
    const deliver = vi.fn((_destination: AuthContinuationDestination) => true);
    expect(flushAuthContinuation({ isAuthenticated: false, entryGate: 'auth', intent: 'customer' }, deliver)).toBe('waiting');
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'selfie', intent: 'customer' }, deliver)).toBe('waiting');
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'vendor' }, deliver)).toBe('delivered');
    const destination = deliver.mock.calls[0]![0];
    expect(destination).toMatchObject({ screen: 'MenuItem', vendorId: 'scanned-store', itemId: 'roti', addDraft: { quantity: 2, selectedOptions: { filling: 'chickpea' } } });
    const route = rootRouteForAuthContinuation(destination);
    expect(route.screen).toBe('Storefront');
    if (!('state' in route.params)) throw new Error('Expected a store/item stack');
    expect(route.params.state.index).toBe(1);
    expect(route.params.state.routes.map(r => r.name)).toEqual(['Restaurant', 'MenuItem']);
    expect(route.params.state.routes[0]!.params).toEqual({ vendorId: 'scanned-store' });
    guest.unmount();
    state.params = route.params.state.routes[1]!.params;
    state.auth.isAuthenticated = true;
    state.vendor = { isLoading: true };
    const signedIn = render(<MenuItemScreen />);
    expect(state.mutate).not.toHaveBeenCalled();
    state.vendor = vendor;
    signedIn.rerender(<MenuItemScreen />);
    await waitFor(() => expect(state.mutate).toHaveBeenCalledExactlyOnceWith({ vendorId: 'scanned-store', itemId: 'roti', quantity: 2, selectedOptions: { filling: 'chickpea' } }, expect.any(Object)));
    expect(screen.getByRole('button', { name: /Chickpea/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Quantity 2' })).toBeTruthy();
    // A rerender, error/retry render or remount cannot replay the consumed intent.
    signedIn.rerender(<MenuItemScreen />);
    signedIn.unmount();
    render(<MenuItemScreen />);
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'customer' }, deliver)).toBe('none');
  });

  it('does not replay Add if the item became unavailable while signing in', () => {
    state.auth.isAuthenticated = true;
    state.params = { ...state.params, addAfterSignIn: true, addDraft: { quantity: 2, selectedOptions: { filling: 'chickpea' }, dayOffset: 0, slot: null, visitMode: 'AT_BUSINESS' } };
    state.vendor = { ...vendor, data: { ...vendor.data, categories: [{ items: [{ ...item, stockQuantity: 0 }] }] } };
    render(<MenuItemScreen />);
    expect(state.mutate).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Out of stock' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('manual booking during a failed slot refresh consumes the queued Add before recovery', () => {
    const slot = '2026-09-30T13:00:00.000Z';
    state.auth.isAuthenticated = true;
    state.params = { ...state.params, addAfterSignIn: true, addDraft: { quantity: 1, selectedOptions: { filling: 'chickpea' }, dayOffset: 1, slot, visitMode: 'MOBILE' } };
    state.vendor = { ...vendor, data: { ...vendor.data, categories: [{ items: [{ ...item, fulfillment: 'APPOINTMENT' }] }] } };
    state.slots = { data: { slots: [slot], serviceMode: 'BOTH' }, isError: true };
    const view = render(<MenuItemScreen />);
    expect(state.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Book / }));
    expect(state.mutate).toHaveBeenCalledOnce();
    state.slots = { ...state.slots, isError: false };
    view.rerender(<MenuItemScreen />);
    expect(state.mutate).toHaveBeenCalledOnce();
    expect(state.params['addAfterSignIn']).toBeUndefined();
  });


  it('[row 70] a signed-in Add sends the item note; an empty note sends none', () => {
    state.auth.isAuthenticated = true;
    render(<MenuItemScreen />);
    fireEvent.change(screen.getByLabelText('Note for the store'), { target: { value: '  No onions  ' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith(
      { vendorId: 'scanned-store', itemId: 'roti', quantity: 1, selectedOptions: { filling: 'pumpkin' }, specialInstructions: 'No onions' },
      expect.any(Object),
    );
  });

  it('[row 70] the item note survives sign-in with the rest of the draft', async () => {
    render(<MenuItemScreen />);
    fireEvent.change(screen.getByLabelText('Note for the store'), { target: { value: 'Extra pepper' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    const deliver = vi.fn((_destination: AuthContinuationDestination) => true);
    expect(flushAuthContinuation({ isAuthenticated: true, entryGate: 'main', intent: 'customer' }, deliver)).toBe('delivered');
    expect(deliver.mock.calls[0]![0]).toMatchObject({ addDraft: { notes: 'Extra pepper' } });
  });
});

describe('[F4] the phone never chooses a sold-out option', () => {
  const soldOutDefault = { ...item, optionGroups: [{ ...item.optionGroups[0]!, options: [
    { id: 'pumpkin', name: 'Pumpkin', isDefault: true, isAvailable: false },
    { id: 'chickpea', name: 'Chickpea', isAvailable: true },
  ] }] };

  it('a sold-out default is shown as sold out, is not pre-selected and cannot be tapped; the customer chooses', () => {
    state.auth.isAuthenticated = true;
    state.vendor = { ...vendor, data: { ...vendor.data, categories: [{ items: [soldOutDefault] }] } };
    render(<MenuItemScreen />);
    const soldOut = screen.getByRole('button', { name: 'Pumpkin · sold out' });
    expect(soldOut.getAttribute('aria-pressed')).not.toBe('true');
    fireEvent.click(soldOut);
    expect(soldOut.getAttribute('aria-pressed')).not.toBe('true');
    expect((screen.getByRole('button', { name: 'Choose required options' }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^Chickpea/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add to cart/ }));
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith(
      { vendorId: 'scanned-store', itemId: 'roti', quantity: 1, selectedOptions: { filling: 'chickpea' } },
      expect.any(Object),
    );
  });
});
