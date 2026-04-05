import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/phone_entry_screen.dart';
import '../../features/auth/presentation/otp_screen.dart';
import '../../features/home/presentation/home_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/auth',
    routes: [
      // Auth flow
      GoRoute(
        path: '/auth',
        builder: (context, state) => const PhoneEntryScreen(),
        routes: [
          GoRoute(
            path: 'otp',
            builder: (context, state) {
              final phone = state.extra as String? ?? '';
              return OtpScreen(phone: phone);
            },
          ),
        ],
      ),

      // Main app (after auth)
      ShellRoute(
        builder: (context, state, child) => HomeScreen(child: child),
        routes: [
          GoRoute(path: '/rides', builder: (context, state) => const Placeholder()),
          GoRoute(path: '/eats', builder: (context, state) => const Placeholder()),
          GoRoute(path: '/courier', builder: (context, state) => const Placeholder()),
          GoRoute(path: '/orders', builder: (context, state) => const Placeholder()),
          GoRoute(path: '/wallet', builder: (context, state) => const Placeholder()),
          GoRoute(path: '/account', builder: (context, state) => const Placeholder()),
        ],
      ),
    ],
  );
});
