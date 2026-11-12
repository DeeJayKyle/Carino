import 'dart:async';
import 'dart:convert';

import 'package:carino/engine/engine.dart';

/// A scripted engine for widget tests: canned replies per "METHOD /path" and a scripted chat stream.
class FakeEngine implements Engine {
  final calls = <String>[];
  final bodies = <String, Object?>{};
  final opened = <String>[];
  final _opens = StreamController<String>.broadcast();
  Map<String, Object? Function(Object? body)> routes;
  List<SseEvent> Function(Object? body) chat;

  FakeEngine({Map<String, Object? Function(Object? body)>? routes, List<SseEvent> Function(Object? body)? chat})
      : routes = routes ?? {},
        chat = chat ?? ((_) => []);

  void emitOpen(String path) => _opens.add(path);

  @override
  Future<void> get ready async {}

  @override
  bool get hasWebScreens => true;

  @override
  Stream<String> get opens => _opens.stream;

  @override
  Future<void> openWebScreen(String path) async => opened.add(path);

  @override
  Future<String> startPath() async => '/';

  Object? Function(Object?)? _find(String key) {
    if (routes.containsKey(key)) return routes[key];
    final noQuery = key.split('?').first;
    return routes[noQuery];
  }

  @override
  Future<EngineResponse> send(String method, String path, {Object? body, Upload? upload, Map<String, String>? headers}) async {
    final key = '$method $path';
    calls.add(key);
    bodies[key] = body;
    final h = _find(key);
    if (h == null) return EngineResponse(404, jsonEncode({'error': 'Not found: $key'}));
    final out = h(body);
    if (out is EngineResponse) return out;
    return EngineResponse(200, jsonEncode(out));
  }

  @override
  Stream<SseEvent> stream(String method, String path, {Object? body}) {
    calls.add('$method $path');
    bodies['$method $path'] = body;
    return Stream.fromIterable(chat(body));
  }
}

Map<String, dynamic> me({bool onboarded = true}) => {
      'user': {'id': 'u1', 'name': 'Herbert', 'email': 'me@this-phone.app'},
      'settings': {
        'onboarded': onboarded,
        'profile': {'displayName': 'Herbert', 'assistantName': 'Carino'},
      },
    };
