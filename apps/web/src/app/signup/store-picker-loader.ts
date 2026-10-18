/**
 * [PERF] The store map picker's code, fetched on demand by the sign-up page
 * (it is a fifth of that page's own code and only a store owner on the
 * business step opens it). Kept in its own module so the page can retry a
 * failed fetch: webpack fetches a chunk again on the next import() after a
 * failure, while a React.lazy component would stay failed and throw into the
 * app's error page, unmounting the form and what the owner typed.
 */
export const loadStorePicker = () => import('@/components/store-location-picker');
