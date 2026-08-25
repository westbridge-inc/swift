import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { vi } from 'vitest';

export const API_ORIGIN = 'http://vendor-api.test';

export interface ApiRequest {
  init: RequestInit | undefined;
  method: string;
  url: URL;
}

export interface ApiReply {
  body: unknown;
  status?: number;
}

/** Stub `fetch` with a handler that sees the parsed method + URL of each call. */
export function mockApi(handler: (_request: ApiRequest) => ApiReply | Promise<ApiReply>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const requestMethod = typeof input === 'object' && 'method' in input ? input.method : undefined;
    const method = (init?.method ?? requestMethod ?? 'GET').toUpperCase();
    const reply = await handler({ init, method, url: new URL(inputUrl) });

    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Explicit, NAMED return type. Inferring it drags in `debug`, whose signature
// reaches into pretty-format's internals; TS then refuses to name the type
// (TS2883). Queries are omitted on purpose — tests use `screen`.
export type RenderedWithQuery = {
  container: RenderResult['container'];
  baseElement: RenderResult['baseElement'];
  rerender: RenderResult['rerender'];
  unmount: RenderResult['unmount'];
  asFragment: RenderResult['asFragment'];
  queryClient: QueryClient;
  user: UserEvent;
};

export function renderWithQuery(ui: ReactElement): RenderedWithQuery {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  const view = render(ui, { wrapper: Wrapper });
  return {
    queryClient,
    user: userEvent.setup(),
    container: view.container,
    baseElement: view.baseElement,
    rerender: view.rerender,
    unmount: view.unmount,
    asFragment: view.asFragment,
  };
}

/**
 * happy-dom has no Web Audio. The vendor new-order takeover synthesises its
 * chime with an AudioContext, so the overlay cannot mount without one.
 */
export function stubAudioContext() {
  const audioParam = () => ({
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createOscillator() {
      return {
        frequency: { value: 0 },
        type: 'sine',
        connect: <T,>(target: T) => target,
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    createGain() {
      return { gain: audioParam(), connect: <T,>(target: T) => target };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
}
