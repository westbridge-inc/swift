import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';
import * as vendorApi from '@/lib/food-handlers-api';
import { FoodHandlersCard } from './food-handlers-card';

// ---------------------------------------------------------------------------
// [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant's owner ticks
// "Everyone who handles food here holds a current food handler's certificate."
// The website carries the tick so an owner on an older phone app can give it
// today. The words and version are the server's; synthetic stores only.
// ---------------------------------------------------------------------------

const TICK = 'Everyone who handles food here holds a current food handler’s certificate.';
const answer = (attested: boolean) => ({ version: 'v1', tick: TICK, stores: [{ vendorId: 'store-2', name: 'Second Sample Kitchen', attested }] });

afterEach(() => vi.restoreAllMocks());

/** Let the read's answer land and render (a card drawn for the wrong store would be on screen by now). */
const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

describe('[FOOD-PERMIT] the food handlers card', () => {
  it('shows the server’s words for the selected restaurant; the button waits for the tick, then sends it', async () => {
    vi.spyOn(vendorApi, 'getFoodHandlers').mockResolvedValue(answer(false));
    const sent = vi.spyOn(vendorApi, 'tickFoodHandlers').mockResolvedValue({} as never);
    renderWithQuery(<FoodHandlersCard storeId="store-2" isOwner />);
    const box = await screen.findByRole('checkbox', { name: TICK });
    const button = screen.getByRole('button', { name: 'Confirm' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveBeenCalledWith('v1'));
  });

  it('once given it says so, and offers nothing to tick', async () => {
    vi.spyOn(vendorApi, 'getFoodHandlers').mockResolvedValue(answer(true));
    renderWithQuery(<FoodHandlersCard storeId="store-2" isOwner />);
    expect(await screen.findByText(/You confirmed:/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a manager, another store, or a server without the words: no card', async () => {
    const read = vi.spyOn(vendorApi, 'getFoodHandlers').mockResolvedValue(answer(false));
    const { container, unmount } = renderWithQuery(<FoodHandlersCard storeId="store-2" isOwner={false} />);
    expect(container.textContent).toBe('');
    expect(read).not.toHaveBeenCalled();
    unmount();
    const other = renderWithQuery(<FoodHandlersCard storeId="store-9" isOwner />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    await settled();
    expect(other.container.textContent).toBe('');
    other.unmount();
    read.mockResolvedValue(null);
    const none = renderWithQuery(<FoodHandlersCard storeId="store-2" isOwner />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await settled();
    expect(none.container.textContent).toBe('');
  });
});

// [FOOD-PERMIT · perf] vendor-api.ts is in every dashboard page's first load; the tick's calls stay out of it.
describe('[FOOD-PERMIT · perf] the food handlers calls are not in the shared vendor API module', () => {
  it('vendor-api.ts holds neither call; the card imports them from food-handlers-api.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const shared = readFileSync(join(process.cwd(), 'src', 'lib', 'vendor-api.ts'), 'utf8');
    const card = readFileSync(join(process.cwd(), 'src', 'app', 'dashboard', 'settings', 'food-handlers-card.tsx'), 'utf8');
    expect(shared).not.toMatch(/FoodHandlers|food-handlers/);
    expect(card).toContain("import { getFoodHandlers, tickFoodHandlers } from '@/lib/food-handlers-api';");
  });
});
