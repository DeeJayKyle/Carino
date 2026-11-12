import 'dart:async';
import 'dart:convert';

import 'engine.dart';

/// The engine in a WebView, linked to Flutter through mobile/flutter-link.ts: requests go in as
/// JSON; replies, streamed chunks and events come back as JSON. Android and Windows differ only in
/// how the JSON is carried.
abstract class LinkedEngine implements Engine {
  var _ready = Completer<void>();
  final _pending = <String, Completer<EngineResponse>>{};
  final _streams = <String, StreamController<SseEvent>>{};
  final _parsers = <String, SseParser>{};
  final _opens = StreamController<String>.broadcast();
  final _events = StreamController<EngineEvent>.broadcast();
  var _seq = 0;

  /// Passes one request (JSON) into the engine.
  Future<void> deliver(String json);

  /// Stops a streamed request.
  Future<void> abortRequest(String id);

  /// Reloads the engine's page.
  Future<void> reload();

  /// A page to open (from a notification, a widget or the system).
  void open(String path) => _opens.add(path);

  /// A message from the engine (JSON).
  void onMessage(String json) {
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
      case 'show':
        _opens.add('show');
      case 'event':
        if (m['data'] is Map) {
          _events.add(EngineEvent('${m['name']}', Map<String, dynamic>.from(m['data'] as Map)));
        } else {
          _opens.add('event:${m['name']}');
        }
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
  Stream<String> get opens => _opens.stream;
  @override
  Stream<EngineEvent> get events => _events.stream;

  @override
  Future<void> restart() async {
    _ready = Completer<void>();
    for (final c in _pending.values) {
      c.completeError(const ApiError(0, 'Carino restarted.'));
    }
    _pending.clear();
    await reload();
    await _ready.future.timeout(const Duration(seconds: 60));
  }

  String _id() => 'f${++_seq}';

  @override
  Future<EngineResponse> send(String method, String path, {Object? body, Upload? upload, Map<String, String>? headers}) async {
    await ready;
    final id = _id();
    final c = Completer<EngineResponse>();
    _pending[id] = c;
    await deliver(jsonEncode({'id': id, 'method': method, 'path': path, 'body': ?body, 'upload': ?upload?.toJson(), 'headers': ?headers}));
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
        await deliver(jsonEncode({'id': id, 'method': method, 'path': path, 'body': ?body}));
      },
      onCancel: () async {
        if (_streams.remove(id) != null) await abortRequest(id);
        _parsers.remove(id);
      },
    );
    return c.stream;
  }
}
