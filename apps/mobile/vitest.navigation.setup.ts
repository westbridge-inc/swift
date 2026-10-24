import { createRequire } from 'node:module';
import { afterAll, vi } from 'vitest';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const { Window } = await import(/* @vite-ignore */ webRequire.resolve('happy-dom'));
const window = new Window({ url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver']) {
  vi.stubGlobal(key, key === 'window' ? window : window[key]);
}
vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
afterAll(() => { window.happyDOM.abort(); vi.unstubAllGlobals(); });
