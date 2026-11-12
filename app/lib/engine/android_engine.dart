import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

import 'engine.dart';

/// The engine in the Android app's WebView, reached through the "carino/engine" channel.
class AndroidEngine implements Engine {
  static const _channel = MethodChannel('carino/engine');
  final _ready = Completer<void>();
  final _pending = <String, Completer<EngineResponse>>{};
  final _streams = <String, StreamController<SseEvent>>{};
  final _parsers = <String, SseParser>{};
  final _opens = StreamController<String>.broadcast();
  var _seq = 0;

  AndroidEngine() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'open') _opens.add(call.arguments as String);
      if (call.method == 'message') _onMessage(call.arguments as String);
    });
  }

  void _onMessage(String json) {
    final Map<String, dynamic> m;
    try {
      m = jsonDecode(json) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    final id = m['id'] as String?;
    switch (m['type']) {
      case 'ready':
        if (!_ready.isCompleted) _ready.complete();
      case 'back':
        _opens.add('back');
      case 'done':
        final b64 = m['b64'] as String?;
        _pending.remove(id)?.complete(EngineResponse(
          (m['status'] as num).toInt(), (m['body'] as String?) ?? '',
          contentType: (m['contentType'] as String?) ?? '', bytes: b64 == null ? null : base64Decode(b64), filename: m['filename'] as String?,
        ));
      case 'head':
        final status = (m['status'] as num).toInt();
        if (status >= 400) _streams[id]?.addError(ApiError(status, 'The request failed ($status).'));
      case 'chunk':
        final s = _streams[id];
        if (s != null) {
          for (final e in _parsers[id]!.add(m['text'] as String)) {
            s.add(e);
          }
        }
      case 'end':
        _parsers.remove(id);
        _streams.remove(id)?.close();
      case 'error':
        final err = ApiError(0, (m['message'] as String?) ?? 'The engine stopped answering.');
        _pending.remove(id)?.completeError(err);
        final s = _streams.remove(id);
        _parsers.remove(id);
        if (s != null) {
          if (m['message'] != 'aborted') s.addError(err);
          s.close();
        }
    }
  }

  @override
  Future<void> get ready => _ready.future;

  @override
  bool get hasWebScreens => true;

  @override
  Stream<String> get opens => _opens.stream;

  @override
  Future<String> startPath() async => (await _channel.invokeMethod<String>('startPath')) ?? '/';

  @override
  Future<void> openWebScreen(String path) => _channel.invokeMethod('open', {'path': path});

  String _id() => 'f${++_seq}';

  @override
  Future<EngineResponse> send(String method, String path, {Object? body, Upload? upload}) async {
    await ready;
    final id = _id();
    final c = Completer<EngineResponse>();
    _pending[id] = c;
    await _channel.invokeMethod('request', {
      'json': jsonEncode({'id': id, 'method': method, 'path': path, 'body': ?body, 'upload': ?upload?.toJson()}),
    });
    return c.future.timeout(const Duration(minutes: 5), onTimeout: () {
      _pending.remove(id);
      throw const ApiError(0, 'Carino took too long to answer.');
    });
  }

  @override
  Stream<SseEvent> stream(String method, String path, {Object? body}) {
    final id = _id();
    late final StreamController<SseEvent> c;
    c = StreamController<SseEvent>(
      onListen: () async {
        await ready;
        _streams[id] = c;
        _parsers[id] = SseParser();
        await _channel.invokeMethod('request', {
          'json': jsonEncode({'id': id, 'method': method, 'path': path, 'body': ?body}),
        });
      },
      onCancel: () async {
        if (_streams.remove(id) != null) await _channel.invokeMethod('abort', {'id': id});
        _parsers.remove(id);
      },
    );
    return c.stream;
  }
}
