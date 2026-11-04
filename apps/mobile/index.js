import { registerRootComponent } from 'expo';
import App from './src/App';
// [PERF #8] Registered with the OS at launch, whatever screen opens (and when
// the OS starts the app in the background for a location update): imported
// for their effect, which inline requires (metro.config.js) never defer.
// After App, so crash reporting still boots before anything else.
import './src/services/backgroundLocation';
import './src/services/push';

registerRootComponent(App);
