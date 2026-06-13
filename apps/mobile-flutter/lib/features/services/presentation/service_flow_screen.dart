import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

/// Entry screen for a vertical flow (ride / food / grocery / send / shop /
/// services), pushed full-screen over the tab bar. Each gets its real flow next;
/// this gives every Home tile a real destination and the right framing today.
class ServiceFlowScreen extends StatelessWidget {
  final String kind;
  const ServiceFlowScreen({super.key, required this.kind});

  _ServiceMeta get _meta {
    switch (kind) {
      case 'ride':
        return const _ServiceMeta('Ride', Icons.local_taxi_outlined,
            'Where to? Set your pickup and destination to see fares.');
      case 'food':
        return const _ServiceMeta('Food', Icons.restaurant_outlined,
            'Browse restaurants near you and order in a few taps.');
      case 'grocery':
        return const _ServiceMeta('Grocery', Icons.local_grocery_store_outlined,
            'Shop supermarkets and have it delivered.');
      case 'send':
        return const _ServiceMeta('Send a package', Icons.local_shipping_outlined,
            'Send something to a friend — set pickup, drop-off, and a rider collects it.');
      case 'shop':
        return const _ServiceMeta('Shop', Icons.shopping_bag_outlined,
            'Browse stores — clothing, electronics, and more.');
      case 'services':
        return const _ServiceMeta('Services', Icons.handyman_outlined,
            'Book cleaning, beauty, repairs, and more by appointment.');
      default:
        return const _ServiceMeta('Swift', Icons.bolt, 'Coming together.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final meta = _meta;
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: AppBar(
        backgroundColor: AppColors.background,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.textPrimary),
          onPressed: () => context.pop(),
        ),
        title: Text(meta.title, style: AppTypography.h3),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                height: 72,
                width: 72,
                decoration: const BoxDecoration(
                  color: AppColors.primarySoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(meta.icon, size: 34, color: AppColors.primary),
              ),
              const SizedBox(height: 20),
              Text(meta.title, style: AppTypography.h2, textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text(meta.blurb, style: AppTypography.body.copyWith(color: AppColors.textSecondary), textAlign: TextAlign.center),
            ],
          ),
        ),
      ),
    );
  }
}

class _ServiceMeta {
  final String title;
  final IconData icon;
  final String blurb;
  const _ServiceMeta(this.title, this.icon, this.blurb);
}
