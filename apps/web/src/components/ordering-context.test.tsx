import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { OrderingContextProvider } from './ordering-context';
import { OrderingContextBar } from './ordering-context-bar';
it('keeps delivery or pickup and the area visible, with ASAP and no scheduled-order picker', async () => {
  render(<OrderingContextProvider><OrderingContextBar /></OrderingContextProvider>);
  const trigger = screen.getByRole('button', { name: 'Change delivery or pickup context' });
  expect(trigger.textContent).toContain('Delivery'); expect(trigger.textContent).toContain('ASAP');
  fireEvent.click(trigger); const sheet = await screen.findByRole('dialog', { name: 'Your order' });
  fireEvent.click(within(sheet).getByRole('radio', { name: 'Pickup' }));
  fireEvent.change(within(sheet).getByLabelText('Store or area'), { target: { value: 'Fixture area' } });
  expect(within(sheet).queryByText('Schedule')).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
  expect(trigger.textContent).toContain('Pickup'); expect(trigger.textContent).toContain('Fixture area');
  expect(localStorage.getItem('swift_ordering_area')).toBeNull();
});
