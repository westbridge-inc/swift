import { create } from 'zustand';

interface CartItem {
  itemId: string;
  name: string;
  basePrice: number;
  customerPrice: number;
  quantity: number;
  options: { groupName: string; optionName: string; basePrice: number; customerPrice: number }[];
  specialInstructions?: string;
  imageUrl?: string;
}

interface CartState {
  vendorId: string | null;
  vendorName: string | null;
  items: CartItem[];
  addItem: (vendorId: string, vendorName: string, item: CartItem) => void;
  removeItem: (itemId: string) => void;
  updateQuantity: (itemId: string, quantity: number) => void;
  clearCart: () => void;
  getSubtotal: () => number;
  getItemCount: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  vendorId: null,
  vendorName: null,
  items: [],
  addItem: (vendorId, vendorName, item) => {
    const state = get();
    if (state.vendorId && state.vendorId !== vendorId) {
      // Clear cart if switching vendors
      set({ vendorId, vendorName, items: [item] });
    } else {
      const existing = state.items.find((i) => i.itemId === item.itemId);
      if (existing) {
        set({
          vendorId,
          vendorName,
          items: state.items.map((i) =>
            i.itemId === item.itemId ? { ...i, quantity: i.quantity + item.quantity } : i,
          ),
        });
      } else {
        set({ vendorId, vendorName, items: [...state.items, item] });
      }
    }
  },
  removeItem: (itemId) =>
    set((state) => ({
      items: state.items.filter((i) => i.itemId !== itemId),
      ...(state.items.length <= 1 ? { vendorId: null, vendorName: null } : {}),
    })),
  updateQuantity: (itemId, quantity) =>
    set((state) => ({
      items: quantity <= 0
        ? state.items.filter((i) => i.itemId !== itemId)
        : state.items.map((i) => (i.itemId === itemId ? { ...i, quantity } : i)),
    })),
  clearCart: () => set({ vendorId: null, vendorName: null, items: [] }),
  getSubtotal: () => get().items.reduce((sum, item) => sum + item.customerPrice * item.quantity, 0),
  getItemCount: () => get().items.reduce((sum, item) => sum + item.quantity, 0),
}));
