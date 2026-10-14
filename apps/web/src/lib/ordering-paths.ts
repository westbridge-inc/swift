/** The ordering pages: where "Delivery or Pickup · ASAP" means something. */
export function showsOrderingContext(pathname: string): boolean {
  return pathname === '/' || pathname === '/cart' || pathname === '/checkout' || pathname === '/market' || pathname === '/explore'
    || pathname === '/order/browse' || pathname === '/order/search' || pathname.startsWith('/store/');
}

/** Where the app frame draws that bar: every ordering page but Home, whose
 *  own top row carries it together with the delivery address (one place
 *  control, as the phone app's Home has one location pill). */
export function framesOrderingContext(pathname: string): boolean {
  return pathname !== '/' && showsOrderingContext(pathname);
}
