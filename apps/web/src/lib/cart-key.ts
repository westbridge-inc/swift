/**
 * The saved cart's query key, keyed to the person and the session epoch (a sign-out or a change
 * of person never shows the last person's cart). Its own module so the checkout can share the key
 * without carrying the shell's account reads (lib/shell-data) in its own chunk a second time.
 */
export function customerCartKey(scope: string, epoch: number) {
  return ['customer', 'cart', scope, epoch] as const;
}
