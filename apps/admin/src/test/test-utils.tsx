import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

export const API_ORIGIN = 'http://admin-api.test';

export interface ApiRequest {
  init: RequestInit | undefined;
  method: string;
  url: URL;
}

export interface ApiReply {
  body: unknown;
  status?: number;
}

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

export function requestsByMethod(fetchMock: ReturnType<typeof mockApi>, method: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const inputMethod = typeof input === 'object' && 'method' in input ? input.method : undefined;
    return (init?.method ?? inputMethod ?? 'GET').toUpperCase() === method.toUpperCase();
  });
}

export function fulfilledParams<T>(value: T): Promise<T> {
  const promise = Promise.resolve(value) as Promise<T> & { status: 'fulfilled'; value: T };
  promise.status = 'fulfilled';
  promise.value = value;
  return promise;
}

export function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return {
    queryClient,
    user: userEvent.setup(),
    ...render(ui, { wrapper: Wrapper }),
  };
}
