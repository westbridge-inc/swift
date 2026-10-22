import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showsOrderingContext } from './ordering-context';
import { framesOrderingContext } from '@/lib/ordering-paths';
import { OrderingContextBar } from './ordering-context-bar';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('the order context bar', () => {
  it('says delivery or pickup and ASAP, offers no scheduled-order picker and no field that changes nothing', async () => {
    render(<OrderingContextBar />);
    const trigger = screen.getByRole('button', { name: /Change delivery or pickup/ });
    expect(trigger.textContent).toContain('Delivery'); expect(trigger.textContent).toContain('address at checkout'); expect(trigger.textContent).toContain('ASAP');
    fireEvent.click(trigger); const sheet = await screen.findByRole('dialog', { name: 'Delivery or pickup' });
    expect(within(sheet).queryByRole('textbox')).toBeNull();
    expect(within(sheet).queryByText(/Schedule/)).toBeNull();
    fireEvent.click(within(sheet).getByRole('radio', { name: /^Pickup/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(trigger.textContent).toContain('Pickup'); expect(trigger.textContent).toContain('from the store');
    expect(localStorage.length).toBe(0);
  });

  it('keeps the choice for the tab, so a reload of the page keeps pickup', async () => {
    const first = render(<OrderingContextBar />);
    fireEvent.click(screen.getByRole('button', { name: /Change delivery or pickup/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('radio', { name: /^Pickup/ }));
    first.unmount();
    render(<OrderingContextBar />);
    expect((await screen.findByRole('button', { name: /^Pickup from the store/ })).textContent).toContain('Pickup');
  });

  it('[owner, staging] lays the sheet out like every other sheet: padded through the shared prop, Swift’s primary button, plain words', async () => {
    render(<OrderingContextBar />);
    fireEvent.click(screen.getByRole('button', { name: /Change delivery or pickup/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Delivery or pickup' });
    // The same panel classes Scan, the phone menu and Switch app pass to the shared sheet.
    expect(sheet.className.split(/\s+/)).toEqual(expect.arrayContaining(['bg-[var(--swift-card)]', 'px-6', 'pb-6', 'pt-5']));
    const done = within(sheet).getByRole('button', { name: 'Done' });
    expect(done.className.split(/\s+/)).toEqual(expect.arrayContaining(['sw-btn', 'sw-btn-block']));
    expect(sheet.textContent).toContain('We confirm the store, price and total before you place your order.');
    expect(sheet.textContent).not.toMatch(/server/i);
  });

  it('[owner, staging] on Home it is the one place control: the delivery address in the pill, changed from the sheet; none in pickup', async () => {
    render(<OrderingContextBar inline deliverTo="12 Main St" addressHref="/order/location" />);
    const trigger = screen.getByRole('button', { name: /^Delivery 12 Main St ASAP ?\. Change delivery or pickup/ });
    expect(trigger.textContent).toContain('12 Main St'); expect(trigger.textContent).not.toContain('address at checkout');
    // On a phone the row is narrow: the pill shows the address itself, "Delivery" and "ASAP" from the wide layout up.
    for (const word of ['Delivery', 'ASAP']) expect(within(trigger).getByText(word, { exact: false, selector: 'span.font-semibold, span.flex-none' }).className.split(/\s+/)).toEqual(expect.arrayContaining(['sr-only', 'wide:not-sr-only']));
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Delivery or pickup' });
    expect(within(sheet).getByRole('link', { name: 'Change delivery address' }).getAttribute('href')).toBe('/order/location');
    fireEvent.click(within(sheet).getByRole('radio', { name: /^Pickup/ }));
    // Pickup has no delivery address anywhere: not in the pill, not in the sheet.
    expect(within(sheet).queryByRole('link', { name: /delivery address/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(trigger.textContent).toContain('from the store'); expect(trigger.textContent).not.toContain('12 Main St');
  });

  it('on Home a guest finds the stores near them from the same sheet', async () => {
    const find = vi.fn();
    render(<OrderingContextBar inline nearMe={{ busy: false, on: false, find }} />);
    const trigger = screen.getByRole('button', { name: /^Delivery address at checkout ASAP/ });
    // [staging screenshot, 390 px] Beside the menu and Sign in, the phone pill says just "Delivery";
    // "address at checkout" and "ASAP" are in its spoken name (visually hidden) and show from the wide layout up.
    expect(within(trigger).getByText('Delivery').className.split(/\s+/)).not.toContain('sr-only');
    for (const words of ['address at checkout', 'ASAP']) expect(within(trigger).getByText(words, { exact: false, selector: 'span.truncate, span.flex-none' }).className.split(/\s+/)).toEqual(expect.arrayContaining(['sr-only', 'wide:not-sr-only']));
    fireEvent.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Delivery or pickup' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show stores near me' }));
    expect(find).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows only on the ordering pages', () => {
    for (const path of ['/', '/store/sample-kitchen', '/cart', '/checkout', '/market', '/order/browse', '/order/search', '/explore']) expect(showsOrderingContext(path), path).toBe(true);
    for (const path of ['/account', '/account/profile', '/orders', '/orders/o1', '/taxi', '/courier', '/order/location']) expect(showsOrderingContext(path), path).toBe(false);
    // Home's own top row carries it (with the delivery address), as the phone app's Home has one location pill.
    expect(framesOrderingContext('/')).toBe(false);
    for (const path of ['/store/sample-kitchen', '/cart', '/checkout', '/market', '/order/browse', '/order/search', '/explore']) expect(framesOrderingContext(path), path).toBe(true);
    for (const path of ['/account', '/orders', '/order/location']) expect(framesOrderingContext(path), path).toBe(false);
  });
});
