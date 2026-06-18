import { FlashList, type FlashListProps } from '@shopify/flash-list';

/**
 * Recycled list — use for ALL data lists (never ScrollView + .map). FlashList
 * recycles row views off the UI thread for 60fps scrolling. Pass `data`,
 * `renderItem`, `keyExtractor`; memoize the row component.
 */
export function List<T>(props: FlashListProps<T>) {
  return <FlashList showsVerticalScrollIndicator={false} {...props} />;
}
