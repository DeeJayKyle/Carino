import 'dart:convert';

import 'engine.dart';

/// The phone's own abilities through the engine (folder picker, save and share, sign-in browser…).
class Device {
  final Api api;
  const Device(this.api);

  Future<Map<String, dynamic>> _call(String action, [Map<String, dynamic> args = const {}]) async =>
      Map<String, dynamic>.from(await api.post('/device/native', {'action': action, ...args}) as Map);

  Future<Map<String, dynamic>> info() => _call('info');
  Future<Map<String, dynamic>?> pickFolder() async => (await _call('pickFolder'))['folder'] as Map<String, dynamic>?;
  Future<void> forgetFolder(String root) => _call('forgetFolder', {'root': root});
  Future<String?> saveFile(String name, String mime, List<int> bytes) async => (await _call('saveFile', {'name': name, 'mime': mime, 'b64': base64Encode(bytes)}))['message'] as String?;
  Future<void> shareFile(String name, String mime, List<int> bytes, {String text = ''}) => _call('shareFile', {'name': name, 'mime': mime, 'b64': base64Encode(bytes), 'text': text});
  Future<void> shareText(String text) => _call('shareText', {'text': text});
  Future<void> openExternal(String url) async {
    final e = api.engine;
    if (e is HostActions) return (e as HostActions).openExternal(url);
    await _call('openExternal', {'url': url});
  }
  /// Opens a sign-in page in the browser; the result comes back by itself. Returns an error, if any.
  Future<String?> openSignIn(String url) async {
    final e = api.engine;
    if (e is HostActions) return (e as HostActions).signIn(url);
    return (await _call('openSignIn', {'url': url}))['error'] as String?;
  }
  Future<void> speak(String text, String lang) => _call('speak', {'text': text, 'lang': lang});
  Future<void> stopSpeaking() => _call('stopSpeaking');
  Future<void> listen(String lang) => _call('listen', {'lang': lang});
  Future<void> stopListening() => _call('stopListening');
  /// Windows: programs the user approved for Carino to open.
  Future<List<Map>> listApps() async => ((await _call('listApps'))['apps'] as List? ?? const []).cast<Map>();
  Future<Map?> pickApp() async => (await _call('pickApp'))['app'] as Map?;
  Future<void> forgetApp(String id) => _call('forgetApp', {'id': id});
  Future<String?> askPlacesPermission() async => (await _call('askPlacesPermission'))['permission'] as String?;
}

/// Downloads an API file (export, backup, calendar) and saves it to the phone's Downloads.
Future<String> saveApiFile(Engine engine, String path, {String fallbackName = 'carino-file'}) async {
  final r = await engine.send('GET', path);
  if (!r.ok) throw ApiError(r.status, 'The download didn’t work (${r.status}).');
  final bytes = r.bytes ?? utf8.encode(r.body);
  final name = r.filename ?? fallbackName;
  return await Device(Api(engine)).saveFile(name, r.contentType.isEmpty ? 'application/octet-stream' : r.contentType.split(';').first, bytes) ?? 'Saved $name';
}
