import { forwardRef, type ReactElement, type Ref } from 'react';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';

/**
 * Recycled list — use for ALL data lists (never ScrollView + .map). FlashList
 * recycles row views off the UI thread for 60fps scrolling. Pass `data`,
 * `renderItem`, `keyExtractor`; memoize the row component. Forwards its ref to
 * the underlying FlashList (scrollToIndex etc.).
 */
function ListInner<T>(props: FlashListProps<T>, ref: Ref<FlashListRef<T>>) {
  return <FlashList ref={ref} showsVerticalScrollIndicator={false} {...props} />;
}

export const List = forwardRef(ListInner) as <T>(
  props: FlashListProps<T> & { ref?: Ref<FlashListRef<T>> },
) => ReactElement;
