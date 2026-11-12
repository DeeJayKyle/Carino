import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'app_state.dart';
import 'nav.dart';
import 'engine/android_engine.dart';
import 'engine/engine.dart';
import 'screens/chats.dart';
import 'screens/home.dart';
import 'screens/more.dart';
import 'screens/tasks.dart';
import 'theme.dart';
import 'widgets/engine_view.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final Engine engine = defaultTargetPlatform == TargetPlatform.android ? AndroidEngine() : UnavailableEngine();
  runApp(CarinoApp(state: AppState(engine)));
}

final navigatorKey = GlobalKey<NavigatorState>();

class CarinoApp extends StatelessWidget {
  final AppState state;
  const CarinoApp({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: MaterialApp(
        title: 'Carino',
        debugShowCheckedModeBanner: false,
        navigatorKey: navigatorKey,
        theme: carinoTheme(Brightness.light),
        darkTheme: carinoTheme(Brightness.dark),
        // The engine's WebView sits underneath everything (see WebScreen).
        builder: (context, child) => Stack(children: [
          if (state.engine.hasWebScreens) const Positioned.fill(child: EngineView()),
          Positioned.fill(child: child ?? const SizedBox()),
        ]),
        home: const Startup(),
      ),
    );
  }
}

/// Waits for the engine, then shows the app (or the first-run setup, which is still a web screen).
class Startup extends StatefulWidget {
  const Startup({super.key});
  @override
  State<Startup> createState() => _StartupState();
}

class _StartupState extends State<Startup> {
  String? _error;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    final app = AppState.read(context);
    try {
      await app.engine.ready.timeout(const Duration(seconds: 60));
      await app.loadMe();
      // The emulator check looks for this line: Flutter reached the engine and read the account.
      debugPrint('Carino: Flutter screens ready (set up: ${app.onboarded})');
      if (!mounted) return;
      setState(() => _ready = true);
      app.engine.opens.listen(_open);
      final start = await app.engine.startPath();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!app.onboarded) {
          _open('/');
        } else if (start != '/') {
          _open(start);
        }
      });
    } catch (e) {
      if (mounted) setState(() => _error = e is TimeoutException ? 'Carino’s engine didn’t start. Close the app and open it again.' : '$e');
    }
  }

  /// Opens a page by its web path (notifications, widgets, the web screens' back button).
  void _open(String path) {
    final nav = navigatorKey.currentState;
    final ctx = navigatorKey.currentContext;
    if (nav == null || ctx == null) return;
    if (path == 'back') {
      nav.popUntil((r) => !(r.settings.name ?? '').startsWith('web:'));
      return;
    }
    openPath(ctx, path);
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(body: Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center))));
    }
    if (!_ready) {
      return Scaffold(
        body: Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text('Carino', style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.primary)),
            const SizedBox(height: 16),
            const SizedBox(width: 28, height: 28, child: CircularProgressIndicator(strokeWidth: 2.5)),
          ]),
        ),
      );
    }
    return const HomeShell();
  }
}

/// The main sections: Home, Chats, To-dos and More.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  static void select(BuildContext context, int index) {
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    _HomeShellState.current?._select(index);
  }

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  static _HomeShellState? current;
  int _index = 0;

  @override
  void initState() {
    super.initState();
    current = this;
    selectTab = _select;
  }

  @override
  void dispose() {
    if (current == this) current = null;
    super.dispose();
  }

  void _select(int i) => setState(() => _index = i);

  @override
  Widget build(BuildContext context) {
    final pages = [HomeScreen(onTab: _select), const ChatsScreen(), const TasksScreen(), const MoreScreen()];
    return Scaffold(
      body: IndexedStack(index: _index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _select,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: 'Chats'),
          NavigationDestination(icon: Icon(Icons.check_circle_outline), selectedIcon: Icon(Icons.check_circle), label: 'To-dos'),
          NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2), label: 'Your stuff'),
        ],
      ),
    );
  }
}

/// Windows and other platforms: the engine host comes in a later phase.
class UnavailableEngine implements Engine {
  @override
  Future<void> get ready => Future.error(const ApiError(0, 'Carino for this system is coming in a later update. Use Carino for Windows for now.'));
  @override
  bool get hasWebScreens => false;
  @override
  Stream<String> get opens => const Stream.empty();
  @override
  Future<void> openWebScreen(String path) async {}
  @override
  Future<EngineResponse> send(String method, String path, {Object? body, Upload? upload}) => Future.error(const ApiError(0, 'Not available'));
  @override
  Future<String> startPath() async => '/';
  @override
  Stream<SseEvent> stream(String method, String path, {Object? body}) => const Stream.empty();
}
