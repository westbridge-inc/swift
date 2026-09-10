import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// happy-dom does not currently implement Blob URLs. The browser implementation
// is exercised by the viewer; this stable test-double lets existing page tests
// drive the authenticated-fetch-to-image-decode boundary.
if (!URL.createObjectURL) {
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:admin-test-media' });
}
if (!URL.revokeObjectURL) {
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
