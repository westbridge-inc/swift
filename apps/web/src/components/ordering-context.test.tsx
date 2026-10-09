import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { OrderingContextProvider, showsOrderingContext } from './ordering-context';
import { OrderingContextBar } from './ordering-context-bar';

beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('the order context bar', () => {
  it('says delivery or pickup and ASAP, offers no scheduled-order picker and no field that changes nothing', async () => {
    render(<OrderingContextProvider><OrderingContextBar /></OrderingContextProvider>);
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
    const first = render(<OrderingContextProvider><OrderingContextBar /></OrderingContextProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Change delivery or pickup/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('radio', { name: /^Pickup/ }));
    first.unmount();
    render(<OrderingContextProvider><OrderingContextBar /></OrderingContextProvider>);
    expect((await screen.findByRole('button', { name: /^Pickup from the store/ })).textContent).toContain('Pickup');
  });

  it('shows only on the ordering pages', () => {
    for (const path of ['/', '/store/sample-kitchen', '/cart', '/checkout', '/market', '/order/browse', '/order/search', '/explore']) expect(showsOrderingContext(path), path).toBe(true);
    for (const path of ['/account', '/account/profile', '/orders', '/orders/o1', '/taxi', '/courier', '/order/location']) expect(showsOrderingContext(path), path).toBe(false);
  });
});
