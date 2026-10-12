/** The ordering pages: where "Delivery or Pickup · ASAP" means something. */
export function showsOrderingContext(pathname: string): boolean {
  return pathname === '/' || pathname === '/cart' || pathname === '/checkout' || pathname === '/market' || pathname === '/explore'
    || pathname === '/order/browse' || pathname === '/order/search' || pathname.startsWith('/store/');
}
