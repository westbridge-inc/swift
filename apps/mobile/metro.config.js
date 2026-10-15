const { getDefaultConfig } = require('expo/metro-config');

// [R4] NativeWind is gone from mobile. Web and admin legitimately keep Tailwind;
// this app styles from @swift/ui tokens through the kit, and a second styling
// system beside it is how two of them drift.
const config = getDefaultConfig(__dirname);

// [PERF #8] Inline requires: a module's code runs the first time something
// uses it, not all at launch. Expo leaves this off by default, so every
// screen's module (about 8.4 MB of JavaScript) was evaluated before the first
// frame. The few modules that must register with the OS at launch whatever
// screen opens (the background-location task, the notification handler) are
// imported for their effect in index.js, which inlining never defers.
const expoTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const options = await expoTransformOptions(...args);
  return { ...options, transform: { ...options.transform, inlineRequires: true } };
};

module.exports = config;
