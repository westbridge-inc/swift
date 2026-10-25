import React, { useState } from 'react';
import { Platform } from 'react-native';
import { SettingsRow } from '../kit';
import { hasJobRing } from '../services/jobRingCapability';
import { jobAlertSettingsCopy, openJobAlertSettings } from '../services/jobAlertSettings';

/** [RINGER] "Let job alerts through Do Not Disturb" (Android) / "through
 *  Focus" (iOS), on the store and mover account screens. Shown only on a
 *  build with the job ring: on builds 9-11 the setting it opens is not there. */
export function JobAlertSettingsRow() {
  const [show] = useState(hasJobRing);
  if (!show) return null;
  const { label, sub } = jobAlertSettingsCopy(Platform.OS);
  return <SettingsRow icon="bell" label={label} sub={sub} onPress={() => void openJobAlertSettings()} />;
}
