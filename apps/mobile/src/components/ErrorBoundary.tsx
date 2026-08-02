/** @jsxImportSource react */
import { Component, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { color, font } from '@swift/ui';
import { reportCrash } from '../lib/crash-reporter';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/**
 * SWIFT-013: catch render-tree errors so a component throw shows a RECOVERABLE
 * screen instead of a white/blank crash, and route the error to the crash
 * reporter. Deliberately uses bare React Native primitives only — the fallback
 * must never depend on the providers (theme/query/navigation) that could be the
 * very thing that failed.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string }): void {
    reportCrash(error, { componentStack: info?.componentStack, source: 'boundary' });
  }

  private reset = (): void => this.setState({ hasError: false });

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: color.surface.subtle }}>
        <Text style={{ fontSize: 22, fontFamily: font.displaySemiBold, color: color.text.primary, marginBottom: 8, textAlign: 'center' }}>
          Something went wrong
        </Text>
        <Text style={{ fontSize: 15, fontFamily: font.body, color: color.text.secondary, textAlign: 'center', marginBottom: 24, lineHeight: 22 }}>
          The app hit an unexpected error. Your data is safe — you can try again.
        </Text>
        <Pressable
          onPress={this.reset}
          accessibilityRole="button"
          style={{ backgroundColor: color.brand[500], paddingVertical: 14, paddingHorizontal: 28, borderRadius: 9999 }}
        >
          <Text style={{ color: color.text.onBrand, fontFamily: font.bodySemiBold, fontSize: 15 }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
