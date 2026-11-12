import 'package:flutter/services.dart';

import 'linked_engine.dart';

/// The engine in the Android app's WebView, reached through the "carino/engine" channel
/// (see MainActivity.java).
class AndroidEngine extends LinkedEngine {
  static const _channel = MethodChannel('carino/engine');

  AndroidEngine() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'open') open(call.arguments as String);
      if (call.method == 'message') onMessage(call.arguments as String);
    });
  }

  @override
  bool get hasWebScreens => true;

  @override
  Future<String> startPath() async => (await _channel.invokeMethod<String>('startPath')) ?? '/';

  @override
  Future<void> openWebScreen(String path) => _channel.invokeMethod('open', {'path': path});

  @override
  Future<void> deliver(String json) => _channel.invokeMethod('request', {'json': json});

  @override
  Future<void> abortRequest(String id) => _channel.invokeMethod('abort', {'id': id});

  @override
  Future<void> reload() => _channel.invokeMethod('restart');
}
