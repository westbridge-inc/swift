/** @jsxImportSource react */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * TIMELINE + STATUSRAIL — ONE COMPONENT, TWO ORIENTATIONS, ONE TRUTH.
 *
 * The order timeline was written inline on DeliveryScreen and a separate
 * three-dot stepper inline on the mover cockpit. Two pieces of code drawing the
 * same idea — where a thing is in its journey — meant two sets of state rules
 * and two accessibility stories. WS-2 asks for the vertical Timeline and the
 * horizontal StatusRail as the SAME component precisely so they cannot drift.
 *
 * `JourneyRail` is NOT superseded by this and is not a duplicate: it draws an
 * A→B pair (a pickup and a dropoff joined by a dashed leg), which is a route,
 * not a sequence of states. A route has two ends; a timeline has N steps and a
 * position within them. Reconciled rather than merged, deliberately.
 *
 * THE CALLER OWNS STATE. This primitive never infers which step is current
 * from a status string, because the real rule is not ordinal: rider dispatch
 * runs alongside kitchen preparation, so a rider status must not tick off
 * "Preparing" unless a server prep fact did. DeliveryScreen encodes that; a
 * primitive that guessed would quietly overrule it. Pass `currentIndex` for the
 * simple case, or `state` per step when the domain has an opinion.
 */

export type TimelineStepState = 'done' | 'current' | 'upcoming';

export type TimelineStep = {
  key: string;
  label: string;
  /** Shown while the step is CURRENT. */
  description: string;
  /** Shown once complete — past tense reads wrong if it stays future. */
  doneDescription?: string;
  /** Shown before it starts — says what WILL happen, never pretends it has. */
  upcomingDescription?: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  /** A server timestamp. Absent → no clock is drawn; never invent one. */
  timestamp?: string | null;
  /** Explicit override. Wins over `currentIndex` when the domain knows better. */
  state?: TimelineStepState;
};

/** Server time → a short clock, or null when there is nothing truthful to show. */
function clockOf(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function resolveState(step: TimelineStep, index: number, currentIndex?: number | null): TimelineStepState {
  if (step.state) return step.state;
  // No position known: nothing is claimed as done. An unknown journey must not
  // render as a finished one.
  if (currentIndex == null) return index === 0 ? 'current' : 'upcoming';
  if (index < currentIndex) return 'done';
  if (index === currentIndex) return 'current';
  return 'upcoming';
}

function describe(step: TimelineStep, state: TimelineStepState): string {
  if (state === 'done') return step.doneDescription ?? step.description;
  if (state === 'upcoming') return step.upcomingDescription ?? step.description;
  return step.description;
}

/** The one accessibility sentence, so both orientations read identically to a
 *  screen reader even though they look nothing alike [WS-3.5]. */
function stepLabel(step: TimelineStep, state: TimelineStepState, time: string | null): string {
  const word = state === 'done' ? 'Complete' : state === 'current' ? 'Current' : 'Upcoming';
  return `${step.label}. ${word}${time ? ` at ${time}` : ''}. ${describe(step, state)}`;
}

const DOT = space['2xl'];

/** Node colours — the one place a step's state becomes a colour. */
function nodeStyle(state: TimelineStepState) {
  return {
    background: state === 'current' ? color.brand[500] : state === 'done' ? color.brand[50] : color.surface.sunken,
    border: state === 'upcoming' ? color.border.strong : color.brand[500],
    borderWidth: state === 'current' ? space.xs / 2 : StyleSheet.hairlineWidth,
    ink: state === 'current' ? color.white : state === 'done' ? color.brand[600] : color.text.muted,
  };
}

function Node({ step, state }: { step: TimelineStep; state: TimelineStepState }) {
  const s = nodeStyle(state);
  return (
    <View
      style={{
        width: DOT,
        height: DOT,
        borderRadius: radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: s.background,
        borderWidth: s.borderWidth,
        borderColor: s.border,
      }}
    >
      {/* A completed step becomes a tick: the icon said what the step WAS, the
          tick says it happened. */}
      <Feather name={state === 'done' ? 'check' : step.icon} size={13} color={s.ink} />
    </View>
  );
}

export type TimelineProps = {
  steps: TimelineStep[];
  /** Index of the current step. Omit when each step carries its own `state`. */
  currentIndex?: number | null;
  orientation?: 'vertical' | 'horizontal';
  style?: ViewStyle;
};

export function Timeline({ steps, currentIndex, orientation = 'vertical', style }: TimelineProps) {
  if (steps.length === 0) return null;
  return orientation === 'horizontal'
    ? <HorizontalRail steps={steps} currentIndex={currentIndex} style={style} />
    : <VerticalTimeline steps={steps} currentIndex={currentIndex} style={style} />;
}

/**
 * THE HORIZONTAL VARIANT — the designated web signature (B30).
 *
 * Same steps, same states, same sentence to a screen reader; it simply lays the
 * rail across instead of down. Descriptions are dropped, not shortened: a rail
 * that squeezes a sentence into 60px is less readable than one that shows the
 * label and lets the accessible name carry the detail.
 */
export function StatusRail(props: Omit<TimelineProps, 'orientation'>) {
  return <Timeline {...props} orientation="horizontal" />;
}

function VerticalTimeline({ steps, currentIndex, style }: Omit<TimelineProps, 'orientation'>) {
  return (
    <View style={style}>
      {steps.map((step, i) => {
        const state = resolveState(step, i, currentIndex);
        const time = clockOf(step.timestamp);
        const last = i === steps.length - 1;
        return (
          <View
            key={step.key}
            accessible
            accessibilityLabel={stepLabel(step, state, time)}
            style={{ flexDirection: 'row', alignItems: 'stretch' }}
          >
            <View style={{ width: space['3xl'], alignItems: 'center' }}>
              <Node step={step} state={state} />
              {last ? null : (
                <View
                  style={{
                    flex: 1,
                    width: StyleSheet.hairlineWidth,
                    minHeight: space['3xl'],
                    // The leg is lit only behind a step that HAPPENED.
                    backgroundColor: state === 'done' ? color.brand[200] : color.border.subtle,
                  }}
                />
              )}
            </View>
            <View style={{ flex: 1, paddingLeft: space.sm, paddingBottom: last ? 0 : space.xl }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md }}>
                <T variant="body" weight={state === 'current' ? 'semibold' : 'medium'} tone={state === 'upcoming' ? 'faint' : 'ink'}>
                  {step.label}
                </T>
                {time ? <T variant="caption" tone="muted">{time}</T> : null}
              </View>
              <T variant="caption" tone={state === 'current' ? 'muted' : 'faint'} style={{ marginTop: space.xs }}>
                {describe(step, state)}
              </T>
            </View>
          </View>
        );
      })}
    </View>
  );
}

function HorizontalRail({ steps, currentIndex, style }: Omit<TimelineProps, 'orientation'>) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'flex-start' }, style]}>
      {steps.map((step, i) => {
        const state = resolveState(step, i, currentIndex);
        const time = clockOf(step.timestamp);
        const last = i === steps.length - 1;
        return (
          <React.Fragment key={step.key}>
            <View
              accessible
              accessibilityLabel={stepLabel(step, state, time)}
              style={{ alignItems: 'center', width: DOT + space.lg }}
            >
              <Node step={step} state={state} />
              <T
                variant="caption"
                weight={state === 'current' ? 'semibold' : 'regular'}
                tone={state === 'upcoming' ? 'faint' : 'ink'}
                center
                numberOfLines={2}
                style={{ marginTop: space.xs }}
              >
                {step.label}
              </T>
            </View>
            {last ? null : (
              <View
                // Decorative: the connector carries no information the labelled
                // nodes either side do not already say.
                accessible={false}
                importantForAccessibility="no"
                style={{
                  flex: 1,
                  height: StyleSheet.hairlineWidth * 2,
                  marginTop: DOT / 2,
                  marginHorizontal: space.xs,
                  borderRadius: radius.full,
                  backgroundColor: state === 'done' ? color.brand[200] : color.border.subtle,
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}
