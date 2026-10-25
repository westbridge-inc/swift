import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteNav } from './site-nav';

describe('SiteNav phone menu', () => {
  it('makes every marketing destination reachable from the menu button', () => {
    render(<SiteNav />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const menu = screen.getByRole('dialog', { name: 'Swift site menu' });
    for (const href of ['/how-it-works', '/vendors', '/drivers', '/pricing', '/faq']) {
      expect(menu.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Swift site menu' })).toBeNull();
  });
});
