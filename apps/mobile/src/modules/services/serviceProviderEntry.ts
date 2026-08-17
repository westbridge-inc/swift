import {
  discardAuthContinuation,
  requestAuthContinuation,
} from '../../navigation/authContinuation';

export type ServiceProviderScreenMode = 'sign-in-required' | 'profile-ready';

export function serviceProviderScreenMode(isAuthenticated: boolean): ServiceProviderScreenMode {
  return isAuthenticated ? 'profile-ready' : 'sign-in-required';
}

/** The sole entry policy for provider onboarding. Guests join the existing
 * root auth flow; authenticated customers keep the direct navigation they had
 * before. */
export function enterServiceProvider(options: {
  isAuthenticated: boolean;
  promptLogin: () => void;
  navigate: (screen: 'ServiceProvider') => void;
}): 'login-requested' | 'opened' {
  if (options.isAuthenticated) {
    discardAuthContinuation();
    options.navigate('ServiceProvider');
    return 'opened';
  }

  requestAuthContinuation({ screen: 'ServiceProvider' }, options.promptLogin);
  return 'login-requested';
}

