/**
 * [G11] Swift's two store pages: the App Store (app id 6815507102, bundle
 * gy.swift.app) and Google Play (package gy.swift.app). The same two links the
 * phone app's update-required screen opens (apps/mobile/src/lib/appVersionGate.ts
 * STORE_URLS); a test pins them equal. Shown only while the server's
 * SWIFT_APP_STORES switch is live (lib/launch-switch.ts).
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6815507102';
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=gy.swift.app';
