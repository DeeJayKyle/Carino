import 'package:flutter/material.dart';

import 'app_state.dart';
import 'screens/applications.dart';
import 'screens/approvals.dart';
import 'screens/chat.dart';
import 'screens/discover.dart';
import 'screens/files.dart';
import 'screens/memory.dart';
import 'screens/money.dart';
import 'screens/notifications.dart';
import 'screens/routines.dart';
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
    if (p == '/' && !AppState.read(context).onboarded) return WebScreen.open(context, '/');
    nav.popUntil((r) => r.isFirst);
    selectTab?.call(tabPaths[p]!);
    return;
  }
  if (p == '/chat/new') {
    final q = uri.queryParameters['q'];
    if (uri.queryParameters['voice'] == '1') return WebScreen.open(context, path);
    return ChatScreen.startNew(context, firstMessage: q);
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
