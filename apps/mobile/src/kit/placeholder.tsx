import React from 'react';
import { Header, Screen } from './screen';
import { EmptyState } from './states';

/** Temporary stand-in while the rebuild lands screen by screen. Every route in
 *  the fresh navigator mounts something real or one of these — never a crash. */
export function makePlaceholder(title: string) {
  return function PlaceholderScreen() {
    return (
      <Screen>
        <Header title={title} />
        <EmptyState
          icon="tool"
          title={`${title} is being rebuilt`}
          body="This screen lands later in the ui-rebuild sequence."
        />
      </Screen>
    );
  };
}
