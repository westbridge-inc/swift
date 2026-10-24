// ---------------------------------------------------------------------------
// [UI-SWEEP U29] The business board's doors to the menu list ("Menu &
// inventory", "Item availability", "Add your first item", the photo check and
// the menu-status row). React Navigation 7's plain navigate PUSHED a second
// menu list on top of whatever the Menu tab held (an item editor left open),
// so Back walked through the stale editor. `pop: true` goes BACK to the Menu
// tab's own list instead, the way the editor's own Back does.
// ---------------------------------------------------------------------------

type MenuDoorNavigation = { navigate: (name: string, params?: Record<string, unknown>) => void };

export function openMenuList(navigation: MenuDoorNavigation): void {
  navigation.navigate('Menu', { screen: 'VendorMenu', pop: true });
}
