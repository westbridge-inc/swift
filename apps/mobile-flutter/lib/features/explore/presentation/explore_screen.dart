import 'package:flutter/material.dart';

import '../../../core/constants/app_colors.dart';
import '../../../core/constants/app_typography.dart';

/// Explore tab — search & discover across every vertical, with a map toggle.
/// (Static scaffold; wires to /search + /customer/vendors next.)
class ExploreScreen extends StatelessWidget {
  const ExploreScreen({super.key});

  static const _categories = ['All', 'Food', 'Grocery', 'Stores', 'Services', 'Rides'];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(
                children: [
                  Expanded(child: Text('Explore', style: AppTypography.h1)),
                  IconButton(
                    onPressed: () {},
                    icon: const Icon(Icons.map_outlined, color: AppColors.textPrimary),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
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
            const SizedBox(height: 12),
            SizedBox(
              height: 36,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: _categories.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (context, i) => _CategoryChip(label: _categories[i], selected: i == 0),
              ),
            ),
            Expanded(
              child: ListView.separated(
                padding: const EdgeInsets.all(16),
                itemCount: 6,
                separatorBuilder: (_, __) => const SizedBox(height: 12),
                itemBuilder: (context, i) => const _ResultRow(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final String label;
  final bool selected;
  const _CategoryChip({required this.label, required this.selected});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: selected ? AppColors.primary : AppColors.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: selected ? AppColors.primary : AppColors.border),
      ),
      child: Text(
        label,
        style: AppTypography.caption.copyWith(
          color: selected ? Colors.white : AppColors.textSecondary,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          height: 64,
          width: 64,
          decoration: BoxDecoration(
            color: AppColors.inputBackground,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.border),
          ),
          child: const Icon(Icons.storefront_outlined, color: AppColors.textTertiary),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Vendor name', style: AppTypography.bodyMedium),
              const SizedBox(height: 4),
              Text('Guyanese · Caribbean · \$\$', style: AppTypography.caption),
              const SizedBox(height: 4),
              Row(
                children: [
                  const Icon(Icons.star, size: 14, color: AppColors.brandGold),
                  const SizedBox(width: 4),
                  Text('4.7 · 25 min · \$500 delivery', style: AppTypography.caption),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
