'use client';

import { BROWSER_API_ORIGIN as API_URL } from './browser-api-origin';
import { BROWSER_CLIENT, getSelectedStore } from './auth';

// [CHAINS PR2] "Export menu (CSV)": the selected store's live menu as the server writes it (GET /vendor/menu/export,
// managers and owners; the import template's columns and the options, every text cell formula-safe), saved as a
// file. The answer is a CSV, not JSON, so it is read here rather than through apiFetch. Loaded on the tap only.
export async function downloadMenuCsv(storeId: string): Promise<void> {
  if (getSelectedStore() !== storeId) throw new Error('The selected store changed. Try again.');
  const res = await fetch(`${API_URL}/api/v1/vendor/menu/export`, {
    credentials: 'include',
    headers: { 'X-Swift-Client': BROWSER_CLIENT, 'x-client-platform': 'web', 'x-vendor-id': storeId },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message || 'Couldn’t export the menu. Try again.');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'swift-menu.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
