import { Component, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CHUNK_RETRY_DELAY_MS } from './chunk-retry';
import { preloadedPart } from './preloaded-part';

// ---------------------------------------------------------------------------
// [PERF] A part of a page that shows only after a tap ships in its own chunk,
// fetched as soon as the page mounts and drawn without Suspense once it is
// here, so the tap draws it in its own frame. A failed background fetch never
// breaks the page; asking for the part fetches again, and a failure then goes
// to the page's error screen.
// ---------------------------------------------------------------------------

type Part = (_props: { label: string }) => ReactNode;
const Window: Part = ({ label }) => <p>window: {label}</p>;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function host(usePart: (_needed: boolean) => Part | undefined, renders: Array<'part' | 'placeholder' | 'closed'> = []) {
  return function Host() {
    const [open, setOpen] = useState(false);
    const Shown = usePart(open);
    renders.push(!open ? 'closed' : Shown ? 'part' : 'placeholder');
    return (
      <div>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && (Shown ? <Shown label="order 1" /> : <p>placeholder</p>)}
      </div>
    );
  };
}

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  override render() { return this.state.error ? <p role="alert">error screen: {String((this.state.error as Error).message)}</p> : this.props.children; }
}

describe('[PERF] preloadedPart', () => {
  it('starts fetching when the page mounts, before anything asks for the part', async () => {
    const load = vi.fn(async () => Window);
    const { usePart } = preloadedPart(load);
    const Host = host(usePart);
    render(<Host />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/window:/)).toBeNull();
    await flush();
  });

  it('once it is here, the tap draws the part in its own render (no placeholder frame)', async () => {
    const renders: Array<'part' | 'placeholder' | 'closed'> = [];
    const { usePart } = preloadedPart(async () => Window);
    const Host = host(usePart, renders);
    render(<Host />);
    await flush();
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByText('window: order 1')).toBeTruthy();
    expect(renders).not.toContain('placeholder');
  });

  it('a page mounted after it arrived has it from its first render; every mount shares one fetch', async () => {
    const load = vi.fn(async () => Window);
    const { usePart } = preloadedPart(load);
    const First = host(usePart);
    const first = render(<First />);
    await flush();
    first.unmount();
    let firstRender: Part | undefined | 'unset' = 'unset';
    function Later() {
      const Shown = usePart(true);
      if (firstRender === 'unset') firstRender = Shown;
      return Shown ? <Shown label="later" /> : <p>placeholder</p>;
    }
    render(<Later />);
    expect(firstRender).toBe(Window);
    expect(screen.getByText('window: later')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('two parts of a page mounting together share one fetch', async () => {
    const load = vi.fn(async () => Window);
    const { usePart } = preloadedPart(load);
    const A = host(usePart);
    const B = host(usePart);
    render(<><A /><B /></>);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a chunk lost on the way is fetched once more after a short pause (lib/chunk-retry)', async () => {
    vi.useFakeTimers();
    try {
      const lost = Object.assign(new Error('Loading chunk 77 failed.'), { name: 'ChunkLoadError' });
      const load = vi.fn<() => Promise<Part>>().mockRejectedValueOnce(lost).mockResolvedValueOnce(Window);
      const { usePart } = preloadedPart(load);
      const Host = host(usePart);
      render(<Host />);
      await act(async () => { await vi.advanceTimersByTimeAsync(CHUNK_RETRY_DELAY_MS); });
      expect(load).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByText('Open'));
      expect(screen.getByText('window: order 1')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tap that beats the fetch shows the placeholder, then the part as soon as it arrives', async () => {
    let arrive: (_part: Part) => void = () => {};
    const { usePart } = preloadedPart(() => new Promise<Part>((resolve) => { arrive = resolve; }));
    const Host = host(usePart);
    render(<Host />);
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByText('placeholder')).toBeTruthy();
    await act(async () => { arrive(Window); });
    expect(screen.getByText('window: order 1')).toBeTruthy();
  });

  it('a failed background fetch never breaks the page; asking for the part fetches it again', async () => {
    const load = vi.fn<() => Promise<Part>>()
      .mockRejectedValueOnce(new Error('offline for a moment'))
      .mockResolvedValueOnce(Window);
    const { usePart } = preloadedPart(load);
    const Host = host(usePart);
    render(<Boundary><Host /></Boundary>);
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Open')).toBeTruthy();
    fireEvent.click(screen.getByText('Open'));
    expect(load).toHaveBeenCalledTimes(2);
    await flush();
    expect(screen.getByText('window: order 1')).toBeTruthy();
  });

  it('asked for and still failing: the failure goes to the page\'s error screen', async () => {
    const load = vi.fn<() => Promise<Part>>().mockRejectedValue(new Error('code missing'));
    const { usePart } = preloadedPart(load);
    const Host = host(usePart);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Boundary><Host /></Boundary>);
    await flush();
    fireEvent.click(screen.getByText('Open'));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('code missing');
    quiet.mockRestore();
  });
});
