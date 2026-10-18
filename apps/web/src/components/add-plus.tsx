import { Plus } from 'lucide-react';

/**
 * [Triage row 113] THE add-to-cart "+": a Swift maroon filled circle with a white plus, the same everywhere on the
 * website (Market cards and the storefront's Add button). Decorative: the button around it carries the words
 * ("Add Pepperpot to cart"), so the glyph is hidden from screen readers.
 */
export function AddPlusGlyph() {
  return (
    <span
      aria-hidden="true"
      data-add-plus=""
      className="grid h-8 w-8 place-items-center rounded-full bg-[var(--swift-red)] text-[var(--swift-white)]"
    >
      <Plus size={18} />
    </span>
  );
}
