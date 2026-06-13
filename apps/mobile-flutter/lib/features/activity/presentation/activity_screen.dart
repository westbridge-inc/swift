import 'package:flutter/material.dart';

import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

/// Activity tab — one place for everything in flight and everything past:
/// rides, deliveries, and sends together. (Static scaffold; wires to
/// /customer/orders + /rides next.)
class ActivityScreen extends StatelessWidget {
  const ActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: AppColors.background,
        body: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Text('Activity', style: AppTypography.h1),
              ),
              const TabBar(
                labelColor: AppColors.primary,
                unselectedLabelColor: AppColors.textTertiary,
                indicatorColor: AppColors.primary,
                tabs: [Tab(text: 'Active'), Tab(text: 'History')],
              ),
              const Expanded(
                child: TabBarView(
                  children: [
                    _EmptyState(
                      icon: Icons.local_shipping_outlined,
                      title: 'Nothing in progress',
                      message: 'Your active rides, orders, and sends show up here.',
                    ),
                    _EmptyState(
                      icon: Icons.history,
                      title: 'No past activity yet',
                      message: 'Once you order or ride, your history lives here.',
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;
  const _EmptyState({required this.icon, required this.title, required this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 48, color: AppColors.textTertiary),
            const SizedBox(height: 16),
            Text(title, style: AppTypography.h3, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(
              message,
              style: AppTypography.caption,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
