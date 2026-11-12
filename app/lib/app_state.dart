import 'package:flutter/widgets.dart';

import 'engine/engine.dart';

/// What every screen needs: the engine, JSON helpers and the signed-in user's settings.
class AppState extends ChangeNotifier {
  final Engine engine;
  final Api api;
  Map<String, dynamic>? me;
  /// Bumped when something may have changed elsewhere (e.g. after a web screen), so lists reload.
  int revision = 0;

  AppState(this.engine) : api = Api(engine);

  Map<String, dynamic> get settings => (me?['settings'] as Map<String, dynamic>?) ?? const {};
  String get name {
    final p = settings['profile'] as Map<String, dynamic>? ?? const {};
    final user = me?['user'] as Map<String, dynamic>? ?? const {};
    final n = (p['displayName'] as String?)?.trim();
    return (n == null || n.isEmpty) ? (user['name'] as String? ?? '') : n;
  }

  String get assistantName {
    final p = settings['profile'] as Map<String, dynamic>? ?? const {};
    final n = (p['assistantName'] as String?)?.trim();
    return (n == null || n.isEmpty) ? 'Carino' : n;
  }

  bool get onboarded => settings['onboarded'] == true;

  Future<void> loadMe() async {
    me = await api.get('/auth/me') as Map<String, dynamic>;
    notifyListeners();
  }

  void changed() {
    revision++;
    notifyListeners();
    loadMe().catchError((_) {});
  }

  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
}
