import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ListToolbar, Pager } from './ListControls';
import { EMPTY_LIST_STATE, rangeText, type ListState } from '@/lib/list-query';

function Controls() {
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  return <><ListToolbar state={state} onChange={setState} searchLabel="Search" filters={[{ key: 'status', label: 'Status', options: [['', 'All'], ['ACTIVE', 'Active']] }]} /><output data-testid="state">{JSON.stringify(state)}</output></>;
}

describe('list controls preserve current choices', () => {
  it('a delayed search keeps a filter selected while typing', async () => {
    render(<Controls />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(JSON.parse(screen.getByTestId('state').textContent!)).toMatchObject({ search: 'shop', filters: { status: 'ACTIVE' } }));
  });
  it('a delayed search keeps show-test-data selected while typing', async () => {
    render(<Controls />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shop' } });
    fireEvent.click(screen.getByLabelText('Show test data'));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('state').textContent!)).toMatchObject({ search: 'shop', showTestData: true }));
  });
  it('recovers a page beyond the shrunken result set', async () => {
    function Shrunk() {
      const [page, setPage] = useState(2);
      return <Pager meta={{ page, limit: 25, total: 25, totalPages: 1, hasPrev: page > 1, hasNext: false }} shown={page === 2 ? 0 : 25} onPage={setPage} />;
    }
    render(<Shrunk />);
    await waitFor(() => expect(screen.getByText('Showing 1–25 of 25')).toBeTruthy());
    expect(screen.queryByText('Showing 26–25 of 25')).toBeNull();
  });
  it('does not invent a reversed range for an empty stale page', () => {
    expect(rangeText({ page: 3, limit: 25, total: 50, totalPages: 2, hasPrev: true, hasNext: false }, 0)).not.toContain('51–50');
  });
});
