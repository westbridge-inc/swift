import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/presentation/phone_entry_screen.dart';
import '../../features/auth/presentation/otp_screen.dart';
import '../../features/shell/presentation/main_shell.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/explore/presentation/explore_screen.dart';
import '../../features/activity/presentation/activity_screen.dart';
import '../../features/account/presentation/account_screen.dart';
import '../../features/services/presentation/service_flow_screen.dart';

/// Consumer navigation:
///   /auth → OTP → /home
///   /home /explore /activity /account  = the 4-tab shell (state preserved)
///   /service/:kind                     = a vertical flow, pushed OVER the bar
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
            builder: (context, state) => OtpScreen(phone: state.extra as String? ?? ''),
          ),
        ],
      ),

      // Vertical flows (ride / food / grocery / send / shop / services) — full
      // screen, pushed above the tab bar so they own the whole canvas.
      GoRoute(
        path: '/service/:kind',
        builder: (context, state) =>
            ServiceFlowScreen(kind: state.pathParameters['kind'] ?? 'ride'),
      ),

      // The 4-tab consumer shell. indexedStack keeps each tab's state alive when
      // you switch — tap away from a half-filled cart and it's still there.
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) =>
            MainShell(navigationShell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [GoRoute(path: '/home', builder: (c, s) => const HomeScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/explore', builder: (c, s) => const ExploreScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/activity', builder: (c, s) => const ActivityScreen())],
          ),
          StatefulShellBranch(
            routes: [GoRoute(path: '/account', builder: (c, s) => const AccountScreen())],
          ),
        ],
      ),
    ],
  );
});
