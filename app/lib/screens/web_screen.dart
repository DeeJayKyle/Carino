import 'package:flutter/material.dart';

import '../app_state.dart';

/// A screen not yet rebuilt in Flutter: the engine shows its own web page, which sits behind this
/// see-through route. The web page's back button (or Android's) returns here.
class WebScreen extends StatefulWidget {
  final String path;
  const WebScreen(this.path, {super.key});

  static Future<void> open(BuildContext context, String path) async {
    final app = AppState.of(context);
    if (!app.engine.hasWebScreens) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('This part of Carino isn’t available here yet.')));
      return;
    }
    await app.engine.openWebScreen(path);
    if (!context.mounted) return;
    await Navigator.of(context).push(PageRouteBuilder<void>(
      opaque: false,
      transitionDuration: Duration.zero,
      reverseTransitionDuration: Duration.zero,
      pageBuilder: (_, _, _) => WebScreen(path),
      settings: RouteSettings(name: 'web:$path'),
    ));
    app.changed();
  }

  @override
  State<WebScreen> createState() => _WebScreenState();
}

class _WebScreenState extends State<WebScreen> {
  @override
  Widget build(BuildContext context) {
    // Nothing drawn and nothing in the way: touches reach the web page underneath.
    return const IgnorePointer(child: SizedBox.expand());
  }
}
