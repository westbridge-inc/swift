/** @jsxImportSource react */
import React, { useState } from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { LinkText, T } from '../../../kit';

/**
 * [P35 · board 4b "Read more"] An item's description, three lines until the customer asks for the rest. A short
 * description is shown whole with no link: a "Read more" that reveals nothing is a control that lies.
 */
export const DESCRIPTION_CLAMP_LINES = 3;
/** About three lines of body text on a phone; past this the description is clamped. */
export const DESCRIPTION_CLAMP_CHARS = 140;

export function descriptionNeedsClamp(text: string): boolean {
  return text.trim().length > DESCRIPTION_CLAMP_CHARS;
}

export function ItemDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clamp = descriptionNeedsClamp(text);
  return (
    <View style={{ gap: space.xs }}>
      <T variant="body" tone="muted" {...(clamp && !open ? { numberOfLines: DESCRIPTION_CLAMP_LINES } : {})}>
        {text}
      </T>
      {clamp ? <LinkText label={open ? 'Show less' : 'Read more'} onPress={() => setOpen((v) => !v)} /> : null}
    </View>
  );
}
