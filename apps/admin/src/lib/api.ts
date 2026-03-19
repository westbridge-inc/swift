const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

async function apiFetch(path: string, options?: RequestInit) {
  const token = typeof window !== 'undefined' ? localStorage.getItem('swift_admin_token') : null;
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const fetchDashboard = () => apiFetch('/api/v1/admin/dashboard/overview');
export const fetchRecentOrders = () => apiFetch('/api/v1/admin/orders?limit=20');
export const fetchUsers = (params?: string) => apiFetch(`/api/v1/admin/users?${params || ''}`);
export const fetchVendors = (status?: string) => apiFetch(`/api/v1/admin/vendors${status ? `?status=${status}` : ''}`);
export const fetchPendingVendors = () => apiFetch('/api/v1/admin/vendors/pending');
export const fetchRiders = () => apiFetch('/api/v1/admin/riders');
export const fetchOrders = (params?: string) => apiFetch(`/api/v1/admin/orders?${params || ''}`);
export const fetchRevenue = () => apiFetch('/api/v1/admin/finance/revenue');
export const fetchPromos = () => apiFetch('/api/v1/admin/promos');
export const fetchConfig = () => apiFetch('/api/v1/admin/config');

export const approveVendor = (id: string) => apiFetch(`/api/v1/admin/vendors/${id}/approve`, { method: 'PUT' });
export const verifyRiderDocuments = (id: string) => apiFetch(`/api/v1/admin/riders/${id}/verify-documents`, { method: 'PUT' });
export const updateConfig = (key: string, value: unknown) =>
  apiFetch(`/api/v1/admin/config/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
