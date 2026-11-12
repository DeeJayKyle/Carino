import 'package:flutter/material.dart';

import 'app_state.dart';
import 'screens/applications.dart';
import 'screens/apps.dart';
import 'screens/approvals.dart';
import 'screens/connections.dart';
import 'screens/connectors.dart';
import 'screens/chat.dart';
import 'screens/discover.dart';
import 'screens/files.dart';
import 'screens/memory.dart';
import 'screens/messaging.dart';
import 'screens/money.dart';
import 'screens/notifications.dart';
import 'screens/access.dart';
import 'screens/onboarding.dart';
import 'screens/ramble.dart';
import 'screens/routines.dart';
import 'screens/settings.dart';
import 'screens/web_screen.dart';

/// Where each page lives: a Flutter screen, or (until it's rebuilt) the engine's own web page.
/// Paths are the same as the web app's, so notifications, widgets and links keep working.
typedef ScreenFor = Widget Function(Uri uri);

final Map<String, ScreenFor> flutterScreens = {
  '/actions': (_) => const ApprovalsScreen(),
  '/notifications': (_) => const NotificationsScreen(),
  '/memory': (u) => MemoryScreen(initialStatus: u.queryParameters['status'] ?? 'active'),
  '/discover': (_) => const DiscoverScreen(),
  '/money': (_) => const MoneyScreen(),
  '/applications': (_) => const ApplicationsScreen(),
  '/files': (_) => const FilesScreen(),
  '/routines': (u) => RoutinesScreen(idea: u.queryParameters['idea']),
  '/settings': (u) => SettingsScreen(section: u.fragment.isEmpty ? null : u.fragment),
  '/access': (_) => const AccessScreen(),
  '/ramble': (_) => const RambleScreen(),
  '/apps': (_) => const AppsScreen(),
  '/connectors': (_) => const ConnectorsScreen(),
  '/connections': (_) => const ConnectionsScreen(),
  '/messaging': (_) => const MessagingScreen(),
};

/// Tabs of the main screen, by path.
const tabPaths = {'/': 0, '/chat': 1, '/tasks': 2, '/stuff': 3, '/me': 3};

/// Called by the main screen to switch tabs.
void Function(int index)? selectTab;

Future<void> openPath(BuildContext context, String path) async {
  final uri = Uri.parse(path);
  final p = uri.path;
  final nav = Navigator.of(context);
  if (tabPaths.containsKey(p) && uri.queryParameters.isEmpty) {
    if (p == '/' && !AppState.read(context).onboarded) {
      final next = await nav.push<String>(MaterialPageRoute(builder: (_) => const OnboardingScreen(), settings: const RouteSettings(name: '/onboarding')));
      if (next != null && context.mounted) await openPath(context, next);
      return;
    }
    nav.popUntil((r) => r.isFirst);
    selectTab?.call(tabPaths[p]!);
    return;
  }
  if (p == '/chat/new') {
    final q = uri.queryParameters['q'];
    return ChatScreen.startNew(context, firstMessage: q, voice: uri.queryParameters['voice'] == '1');
  }
  final appId = RegExp(r'^/apps/(\w+)$').firstMatch(p);
  if (appId != null) {
    await nav.push(MaterialPageRoute<void>(builder: (_) => AppsScreen(id: appId.group(1))));
    return;
  }
  final chat = RegExp(r'^/chat/([\w-]+)$').firstMatch(p);
  if (chat != null) {
    await nav.push(MaterialPageRoute<void>(builder: (_) => ChatScreen(conversationId: chat.group(1)!)));
    return;
  }
  final screen = flutterScreens[p];
  if (screen != null) {
    await nav.push(MaterialPageRoute<void>(builder: (_) => screen(uri), settings: RouteSettings(name: p)));
    if (context.mounted) AppState.read(context).changed();
    return;
  }
  return WebScreen.open(context, path);
}
