/// Runtime feature flags.
///
/// Fintech/Wallet is fully built in the backend but stays dark on the consumer
/// app until BaaS licensing + APIs are live. Flip [walletEnabled] to surface the
/// Wallet entry inside Account; once it earns its own bottom-bar tab, the shell
/// is designed to add a 5th branch with no re-architecture.
class FeatureFlags {
  FeatureFlags._();

  static const bool walletEnabled = false;
}
