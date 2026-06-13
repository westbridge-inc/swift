import 'package:flutter/material.dart';

import '../../../core/config/feature_flags.dart';
import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

/// Account tab — profile, addresses, switch-to-earning, settings.
/// Wallet stays hidden until BaaS is licensed (FeatureFlags.walletEnabled).
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        bottom: false,
        child: ListView(
          children: [
            const SizedBox(height: 8),
            const _ProfileHeader(),
            const SizedBox(height: 8),
            const _SwitchToEarning(),
            const _Group(
              items: [
                _Item(Icons.location_on_outlined, 'Saved addresses'),
                _Item(Icons.favorite_border, 'Favorites'),
                _Item(Icons.receipt_long_outlined, 'Order history'),
              ],
            ),
            // Dormant fintech: surfaces only when licensed.
            if (FeatureFlags.walletEnabled)
              const _Group(items: [_Item(Icons.account_balance_wallet_outlined, 'Wallet')]),
            const _Group(
              items: [
                _Item(Icons.notifications_outlined, 'Notifications'),
                _Item(Icons.help_outline, 'Help & support'),
                _Item(Icons.shield_outlined, 'Refund & guarantee policy'),
                _Item(Icons.settings_outlined, 'Settings'),
              ],
            ),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _ProfileHeader extends StatelessWidget {
  const _ProfileHeader();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          const CircleAvatar(
            radius: 28,
            backgroundColor: AppColors.primarySoft,
            child: Icon(Icons.person, color: AppColors.primary, size: 28),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Your name', style: AppTypography.h3),
                const SizedBox(height: 2),
                Text('+592 600 0000', style: AppTypography.caption),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: AppColors.textTertiary),
        ],
      ),
    );
  }
}

class _SwitchToEarning extends StatelessWidget {
  const _SwitchToEarning();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: AppColors.primary,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          children: [
            const Icon(Icons.work_outline, color: Colors.white),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Start earning with Swift',
                    style: AppTypography.bodyMedium.copyWith(color: Colors.white),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Drive, deliver, or sell — keep 100%',
                    style: AppTypography.caption.copyWith(color: Colors.white70),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: Colors.white),
          ],
        ),
      ),
    );
  }
}

class _Item {
  final IconData icon;
  final String label;
  const _Item(this.icon, this.label);
}

class _Group extends StatelessWidget {
  final List<_Item> items;
  const _Group({required this.items});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          for (var i = 0; i < items.length; i++) ...[
            ListTile(
              leading: Icon(items[i].icon, color: AppColors.textPrimary),
              title: Text(items[i].label, style: AppTypography.body),
              trailing: const Icon(Icons.chevron_right, color: AppColors.textTertiary),
              onTap: () {},
            ),
            if (i != items.length - 1)
              const Divider(height: 1, indent: 56, color: AppColors.divider),
          ],
        ],
      ),
    );
  }
}
