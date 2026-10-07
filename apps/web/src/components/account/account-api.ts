import { ApiRequestError, apiFetch } from '@/lib/auth';

// Curated errors from the customer routes and their shared error handler.
const customerErrorCodes = new Set([
  'VALIDATION_ERROR', 'NOT_FOUND', 'FORBIDDEN', 'EMAIL_TAKEN',
  'ACCOUNT_INACTIVE', 'MAX_ADDRESSES', 'NOT_YOUR_ORDER',
]);

export interface Favourite { id: string; name: string }
export interface Profile { id: string; firstName: string; lastName: string; email: string | null; phone: string }
export interface Address {
  id: string; label: string; addressLine1: string; addressLine2?: string; city: string; region?: string;
  latitude: number; longitude: number; instructions?: string; isDefault: boolean;
}
export type AddressInput = Omit<Address, 'id' | 'isDefault'> & { isDefault?: boolean };
export interface Consent { consents: { documentType: string; state: string | null; current: boolean }[] }
export type SupportCategory = 'ORDER_ISSUE' | 'PAYMENT' | 'SAFETY' | 'ACCOUNT' | 'VENDOR' | 'MOVER' | 'OTHER';
export interface Ticket { id: string; subject: string; status: string; adminNote?: string | null }
export interface TicketInput { category: SupportCategory; subject: string; message: string; orderId?: string }

// The phone's customerApi contracts, using the web's cookie/session guard.
// Private reads are never cached by the browser; expiry leaves the shell's door visible.
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  try {
    const response = await apiFetch(`/api/v1/customer${path}`, {
      method, cache: 'no-store', headers: { 'x-client-platform': 'web' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { redirectOnExpired: false });
    return response.data as T;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 403 && error.code === 'STEP_UP_REQUIRED') throw error;
    const curated = error instanceof ApiRequestError && error.status >= 400 && error.status < 500
      && customerErrorCodes.has(error.code ?? '');
    throw new Error(curated ? error.message : 'Something went wrong. Please try again.');
  }
}

export const accountApi = {
  profile: () => request<Profile>('/profile'),
  updateProfile: (body: { firstName: string; lastName: string; email?: string }) => request<Profile>('/profile', 'PUT', body),
  consent: () => request<Consent>('/consent'),
  marketing: (granted: boolean) => request('/consent/marketing', 'POST', { granted }),
  addresses: () => request<Address[]>('/addresses'),
  addAddress: (body: AddressInput) => request<Address>('/addresses', 'POST', body),
  updateAddress: (id: string, body: Omit<AddressInput, 'isDefault'>) => request<Address>(`/addresses/${encodeURIComponent(id)}`, 'PUT', body),
  deleteAddress: (id: string) => request(`/addresses/${encodeURIComponent(id)}`, 'DELETE'),
  defaultAddress: (id: string) => request<Address>(`/addresses/${encodeURIComponent(id)}/default`, 'PUT'),
  favourites: () => request<Favourite[]>('/favorites'),
  favourite: (id: string, saved: boolean) => request(`/favorites/${encodeURIComponent(id)}`, saved ? 'DELETE' : 'POST', saved ? undefined : {}),
  tickets: () => request<Ticket[]>('/support'),
  createTicket: (body: TicketInput) => request<Pick<Ticket, 'id' | 'status'>>('/support', 'POST', body),
};
