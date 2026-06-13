import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

/// Home tab — the super-app launcher. Address + search up top, every vertical
/// as a big tap target, then contextual rails. (Static placeholders for now;
/// wires to GET /customer/home next.)
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  static const _services = <_Service>[
    _Service('ride', 'Ride', Icons.local_taxi_outlined),
    _Service('food', 'Food', Icons.restaurant_outlined),
    _Service('grocery', 'Grocery', Icons.local_grocery_store_outlined),
    _Service('send', 'Send', Icons.local_shipping_outlined),
    _Service('shop', 'Shop', Icons.shopping_bag_outlined),
    _Service('services', 'Services', Icons.handyman_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            const _TopBar(),
            const _SearchField(),
            const SizedBox(height: 8),
            _ServiceGrid(services: _services),
            const SizedBox(height: 8),
            const _SectionHeader(title: 'Order again'),
            const _VendorRail(),
            const _SectionHeader(title: 'Popular near you'),
            const _VendorRail(),
            const SizedBox(height: 24),
          ],
        ),
      ),
    );
  }
}

class _Service {
  final String kind;
  final String label;
  final IconData icon;
  const _Service(this.kind, this.label, this.icon);
}

class _TopBar extends StatelessWidget {
  const _TopBar();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
      child: Row(
        children: [
          const Icon(Icons.location_on_outlined, size: 20, color: AppColors.primary),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Deliver to', style: AppTypography.small),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        '42 Regent Street, Georgetown',
                        style: AppTypography.bodyMedium,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    const Icon(Icons.keyboard_arrow_down, size: 18, color: AppColors.textSecondary),
                  ],
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.notifications_outlined, color: AppColors.textPrimary),
            onPressed: () {},
          ),
          const CircleAvatar(
            radius: 16,
            backgroundColor: AppColors.inputBackground,
            child: Icon(Icons.person_outline, size: 18, color: AppColors.textSecondary),
          ),
          const SizedBox(width: 8),
        ],
      ),
    );
  }
}

class _SearchField extends StatelessWidget {
  const _SearchField();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: GestureDetector(
        onTap: () => context.go('/explore'),
        child: Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              const Icon(Icons.search, size: 20, color: AppColors.textTertiary),
              const SizedBox(width: 10),
              Text(
                'Search food, stores, anything',
                style: AppTypography.body.copyWith(color: AppColors.textTertiary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ServiceGrid extends StatelessWidget {
  final List<_Service> services;
  const _ServiceGrid({required this.services});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: GridView.count(
        crossAxisCount: 3,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 12,
        crossAxisSpacing: 12,
        childAspectRatio: 0.95,
        children: services.map((s) => _ServiceTile(service: s)).toList(),
      ),
    );
  }
}

class _ServiceTile extends StatelessWidget {
  final _Service service;
  const _ServiceTile({required this.service});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => context.push('/service/${service.kind}'),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.border),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                height: 48,
                width: 48,
                decoration: const BoxDecoration(
                  color: AppColors.primarySoft,
                  shape: BoxShape.circle,
                ),
                child: Icon(service.icon, color: AppColors.primary, size: 24),
              ),
              const SizedBox(height: 10),
              Text(service.label, style: AppTypography.bodyMedium.copyWith(fontSize: 14)),
            ],
          ),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final String title;
  const _SectionHeader({required this.title});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(title, style: AppTypography.h3),
          Text('See all', style: AppTypography.caption.copyWith(color: AppColors.primary)),
        ],
      ),
    );
  }
}

class _VendorRail extends StatelessWidget {
  const _VendorRail();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 184,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16),
        itemCount: 5,
        separatorBuilder: (_, __) => const SizedBox(width: 12),
        itemBuilder: (context, i) => const _VendorCard(),
      ),
    );
  }
}

class _VendorCard extends StatelessWidget {
  const _VendorCard();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 200,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            height: 110,
            decoration: BoxDecoration(
              color: AppColors.inputBackground,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: const Icon(Icons.storefront_outlined, color: AppColors.textTertiary, size: 32),
          ),
          const SizedBox(height: 8),
          Text('Oasis Cafe', style: AppTypography.bodyMedium.copyWith(fontSize: 15)),
          const SizedBox(height: 2),
          Row(
            children: [
              const Icon(Icons.star, size: 14, color: AppColors.brandGold),
              const SizedBox(width: 4),
              Text('4.8 · 25 min', style: AppTypography.caption),
            ],
          ),
        ],
      ),
    );
  }
}
