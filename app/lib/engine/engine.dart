import 'dart:async';
import 'dart:convert';

/// Carino's engine: its server code, database and AI agent. In the Android app it runs in a
/// WebView (see android/app/src/main/java/app/carino/android/MainActivity.java); the screens talk to
/// it with API requests, exactly like the web screens do.
abstract class Engine {
  /// Completes when the engine has started and can answer requests.
  Future<void> get ready;

  /// One API request; [path] is under /api (e.g. "/tasks?view=today").
  Future<EngineResponse> send(String method, String path, {Object? body, Upload? upload});

  /// A streamed request (Server-Sent Events), e.g. a chat reply. Cancelling the subscription stops it.
  Stream<SseEvent> stream(String method, String path, {Object? body});

  /// Whether this engine can show its own web screens (for screens not yet built in Flutter).
  bool get hasWebScreens;

  /// Shows one of the engine's own web screens.
  Future<void> openWebScreen(String path);

  /// Pages to open, from notifications, widgets and the web screens' back button ("back").
  Stream<String> get opens;

  /// The page Carino was opened to (from a notification or a widget), or "/".
  Future<String> startPath();
}

class Upload {
  final String field;
  final String name;
  final String mime;
  final List<int> bytes;
  final Map<String, String> fields;
  const Upload({this.field = 'file', required this.name, required this.mime, required this.bytes, this.fields = const {}});

  Map<String, Object> toJson() => {
        'files': [
          {'field': field, 'name': name, 'mime': mime, 'b64': base64Encode(bytes)}
        ],
        'fields': fields,
      };
}

class EngineResponse {
  final int status;
  final String contentType;
  final String body;
  final List<int>? bytes;
  final String? filename;
  const EngineResponse(this.status, this.body, {this.contentType = 'application/json', this.bytes, this.filename});

  bool get ok => status >= 200 && status < 300;
  dynamic get json => body.isEmpty ? null : jsonDecode(body);
}

/// An error the engine reported, in words for the user.
class ApiError implements Exception {
  final int status;
  final String message;
  final String? code;
  final Object? data;
  const ApiError(this.status, this.message, {this.code, this.data});
  @override
  String toString() => message;
}

class SseEvent {
  final String event;
  final Map<String, dynamic> data;
  const SseEvent(this.event, this.data);
  @override
  String toString() => 'SseEvent($event, $data)';
}

/// Turns streamed text into events ("event: x" + "data: {...}" blocks separated by a blank line).
class SseParser {
  final _buf = StringBuffer();

  List<SseEvent> add(String chunk) {
    _buf.write(chunk.replaceAll('\r\n', '\n'));
    final text = _buf.toString();
    final out = <SseEvent>[];
    var start = 0;
    while (true) {
      final end = text.indexOf('\n\n', start);
      if (end < 0) break;
      final block = text.substring(start, end);
      start = end + 2;
      var event = 'message';
      final data = StringBuffer();
      for (final line in block.split('\n')) {
        if (line.startsWith('event:')) event = line.substring(6).trim();
        if (line.startsWith('data:')) data.write(line.substring(5).trimLeft());
      }
      if (data.isEmpty) continue;
      try {
        final decoded = jsonDecode(data.toString());
        out.add(SseEvent(event, decoded is Map<String, dynamic> ? decoded : {'value': decoded}));
      } catch (_) {
        out.add(SseEvent(event, {'raw': data.toString()}));
      }
    }
    _buf
      ..clear()
      ..write(text.substring(start));
    return out;
  }
}

/// JSON helpers over an [Engine]: decoded replies, and the engine's error messages as [ApiError].
class Api {
  final Engine engine;
  const Api(this.engine);

  Future<dynamic> get(String path) => _json('GET', path);
  Future<dynamic> post(String path, [Object? body]) => _json('POST', path, body ?? const {});
  Future<dynamic> patch(String path, Object body) => _json('PATCH', path, body);
  Future<dynamic> delete(String path) => _json('DELETE', path);

  Future<dynamic> _json(String method, String path, [Object? body]) async {
    final r = await engine.send(method, path, body: body);
    dynamic data;
    try {
      data = r.json;
    } catch (_) {
      data = r.body;
    }
    if (!r.ok) {
      final m = data is Map ? data : const {};
      throw ApiError(r.status, (m['error'] as String?) ?? 'Something went wrong (${r.status}).', code: m['code'] as String?, data: data);
    }
    return data;
  }
}
