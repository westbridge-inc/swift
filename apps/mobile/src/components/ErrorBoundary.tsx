/** @jsxImportSource react */
import { Component, type ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
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
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: '#111111', marginBottom: 8, textAlign: 'center' }}>
          Something went wrong
        </Text>
        <Text style={{ fontSize: 14, color: '#555555', textAlign: 'center', marginBottom: 24, lineHeight: 20 }}>
          The app hit an unexpected error. Your data is safe — you can try again.
        </Text>
        <Pressable
          onPress={this.reset}
          accessibilityRole="button"
          style={{ backgroundColor: '#111111', paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10 }}
        >
          <Text style={{ color: '#ffffff', fontWeight: '600' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}
