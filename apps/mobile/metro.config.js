const { getDefaultConfig } = require('expo/metro-config');

// [R4] NativeWind is gone from mobile. Web and admin legitimately keep Tailwind;
// this app styles from @swift/ui tokens through the kit, and a second styling
// system beside it is how two of them drift.
module.exports = getDefaultConfig(__dirname);
