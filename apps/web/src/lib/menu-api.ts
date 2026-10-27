import { apiFetch, ApiRequestError } from '@/lib/auth';
import type { CatalogItem } from '@/lib/vendor-api';

// [TAP-AUDIT 27 Oct · owner rule 11 Oct: the website copies the app] The menu writes the phone's item editor and
// Products tab make (apps/mobile/src/services/api.ts vendorApi, same routes, same bodies), so the web dashboard can add
// and edit an item with its photo and options, and add, rename and delete sections — before this the web could only
// switch items on/off, change a price and bulk-import. Loaded only with the editor (the Products page's first load
// does not carry it).

const V = '/api/v1/vendor';

export type BulkWord = 'normal' | 'bulky' | 'very_bulky';
export type OptionRow = { id: string; name: string; additionalPrice: string | number; isAvailable?: boolean };
export type OptionGroupRow = { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: OptionRow[] };
/** An item as the server answers it to the editor (GET /items row, POST/PUT /items answer). */
export type MenuItem = CatalogItem & {
  categoryId?: string;
  description?: string | null;
  isPopular?: boolean;
  bulk?: BulkWord;
  fulfillment?: string;
  bookingConfig?: { durationMinutes?: number; slots?: Array<{ dayOfWeek: number; start: string; end: string }>; serviceMode?: 'AT_BUSINESS' | 'MOBILE' | 'BOTH'; serviceRadiusKm?: number } | null;
  optionGroups?: OptionGroupRow[];
};
export type Section = { id: string; name: string; imageUrl?: string | null; items?: unknown[] };

/** The editor's body for POST /vendor/items (with `optionGroups` on a new item) or PUT /vendor/items/:id. */
export type ItemBody = Record<string, unknown>;

const data = <T>(r: { data?: unknown }) => r.data as T;

export const createItem = (body: ItemBody) => apiFetch(`${V}/items`, { method: 'POST', body: JSON.stringify(body) }).then(data<MenuItem>);
export const saveItem = (id: string, body: ItemBody) => apiFetch(`${V}/items/${id}`, { method: 'PUT', body: JSON.stringify(body) }).then(data<MenuItem>);
export const deleteItem = (id: string) => apiFetch(`${V}/items/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);
export const uploadItemPhoto = (id: string, file: Blob, name: string) => {
  const form = new FormData();
  form.append('file', file, name);
  return apiFetch(`${V}/items/${id}/image`, { method: 'POST', body: form }).then(data<{ id: string; imageUrl: string | null }>);
};

export const createSection = (name: string) => apiFetch(`${V}/categories`, { method: 'POST', body: JSON.stringify({ name }) }).then(data<Section>);
export const renameSection = (id: string, name: string) => apiFetch(`${V}/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }).then(data<Section>);
export const deleteSection = (id: string) => apiFetch(`${V}/categories/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean; itemsRemoved: number }>);

export const addOptionGroup = (itemId: string, body: { name: string; isRequired: boolean; minSelect: number; maxSelect: number }) =>
  apiFetch(`${V}/items/${itemId}/option-groups`, { method: 'POST', body: JSON.stringify(body) }).then(data<OptionGroupRow>);
export const deleteOptionGroup = (id: string) => apiFetch(`${V}/option-groups/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);
export const addOption = (groupId: string, body: { name: string; additionalPrice: number }) =>
  apiFetch(`${V}/option-groups/${groupId}/options`, { method: 'POST', body: JSON.stringify(body) }).then(data<OptionRow>);
export const deleteOption = (id: string) => apiFetch(`${V}/options/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);

/** [REVIEW-F #2142 S4-2, as the phone's #2141] The item or its section was deleted on another device: the server's
 *  "Category with id … not found" names an internal id, so the store reads this instead. */
export const ITEM_GONE_WORDS = 'This section or item was removed on another phone. Go back and open the menu again.';

/** Why the server refused, in its own words (a banned word, documents not yet checked). A refusal with no words for a
 *  person (the form's shape, a duplicate, a server fault) gives null, so the caller keeps its own sentence; a missing
 *  item or section says so in plain words. */
export function refusalWords(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'NOT_FOUND') return ITEM_GONE_WORDS;
  if (error.code === 'VALIDATION_ERROR' || error.code === 'DUPLICATE' || error.code === 'INTERNAL_ERROR' || !error.message.trim()) return null;
  return error.message;
}

/** A photo sized in the browser before it is sent, like the phone app does (long edge 1280 px, JPEG): a few hundred
 *  KB instead of a multi-MB camera original. It is drawn upright (the camera's orientation applied, since the re-encode
 *  drops the EXIF that carried it) on white (JPEG has no transparency: a transparent PNG would otherwise turn black —
 *  REVIEW-F #2142 S3-1). Anything that cannot be sized (no canvas, a format the browser cannot draw, no 2D context) is
 *  sent as chosen — never dropped, never a blank image. The server still checks, scans and redraws every photo. */
export async function sizedPhoto(file: File, edge = 1280): Promise<{ blob: Blob; name: string }> {
  const original = { blob: file as Blob, name: file.name };
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return original;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 600_000) { bitmap.close?.(); return original; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return original; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    return blob && blob.size > 0 ? { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' } : original;
  } catch {
    return original;
  }
}
