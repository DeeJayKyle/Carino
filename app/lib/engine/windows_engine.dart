import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_windows/webview_windows.dart';

import '../windows/host.dart';
import '../windows/vault.dart';
import 'engine.dart';
import 'linked_engine.dart';

/// Where the earlier Carino for Windows kept its data. The engine runs at the same address
/// (http://tauri.localhost) in the same WebView2 data folder, so everything carries over.
const _origin = 'http://tauri.localhost';
const _identifier = 'app.carino.desktop';
const _loopbackPort = 47823;

/// Gives the engine the same `__TAURI__` interface the earlier Windows app had (see
/// mobile/engine.ts), carried over WebView2 messages, plus the Flutter link.
const _shim = r'''
(() => {
  const w = window.chrome && window.chrome.webview;
  if (!w || window.__carinoHost) return;
  let seq = 0;
  const waiting = new Map();
  const listeners = new Map();
  window.__carinoHost = {
    resolve(id, ok, value) {
      const p = waiting.get(id);
      if (!p) return;
      waiting.delete(id);
      ok ? p[0](value) : p[1](value);
    },
    emit(name, payload) { for (const cb of listeners.get(name) || []) cb({ payload }); },
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, args) => new Promise((ok, no) => { const id = ++seq; waiting.set(id, [ok, no]); w.postMessage({ k: 'invoke', id, cmd, args: args || {} }); }) },
    event: { listen: async (name, cb) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(cb); return () => {}; } },
  };
  window.CarinoFlutter = { post: (json) => w.postMessage({ k: 'flutter', json }) };
})();
''';

/// Carino for Windows: the engine in a WebView2 (hidden under the Flutter screens), and the PC
/// abilities it needs (folders, apps, sync with the phone, the key vault) in Dart.
class WindowsEngine extends LinkedEngine implements HostActions {
  final controller = WebviewController();
  late final Directory _data;
  late final Folders _folders;
  late final Apps _apps;
  SyncListener? _listener;
  int _syncPort = SyncListener.defaultPort;
  final _syncWaiting = <int, Completer<String>>{};
  var _syncSeq = 0;
  HttpServer? _signIn;
  WebviewController? _agent;

  WindowsEngine() {
    _start();
  }

  /// The Flutter widget that shows the engine's own pages (for screens still on the web).
  Widget view() => Webview(controller);

  Future<void> _start() async {
    final local = Platform.environment['LOCALAPPDATA'] ?? Directory.systemTemp.path;
    _data = Directory(p.join(local, _identifier))..createSync(recursive: true);
    _folders = Folders(_data);
    _apps = Apps(_data, _folders);
    try {
      await WebviewController.initializeEnvironment(userDataPath: p.join(_data.path, 'EBWebView'));
      await controller.initialize();
      await controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
      final engineDir = p.join(p.dirname(Platform.resolvedExecutable), 'engine');
      await controller.addVirtualHostNameMapping('tauri.localhost', engineDir, WebviewHostResourceAccessKind.allow);
      await controller.addScriptToExecuteOnDocumentCreated(_shim);
      controller.webMessage.listen(_onWebMessage);
      await controller.loadUrl('$_origin/?flutter=1');
    } catch (e) {
      debugPrint('Carino: the engine could not start: $e');
    }
    final port = int.tryParse(Platform.environment['CARINO_SYNC_PORT'] ?? '');
    if (port != null) _syncPort = port;
    try {
      _listener = await SyncListener.start(_syncRequest, port: _syncPort);
    } catch (e) {
      debugPrint('Carino: sync listener: $e');
    }
  }

  /// A paired phone's request: the engine opens it with the pair's key and answers.
  Future<String> _syncRequest(String body) {
    final id = ++_syncSeq;
    final c = Completer<String>();
    _syncWaiting[id] = c;
    _js('window.__carinoHost && __carinoHost.emit("carino-sync-request", ${jsonEncode({'id': id, 'body': body})})');
    return c.future.timeout(const Duration(seconds: 60), onTimeout: () {
      _syncWaiting.remove(id);
      throw 'Carino on the PC didn’t answer in time';
    });
  }

  Future<void> _js(String script) async {
    try {
      await controller.executeScript(script);
    } catch (_) {}
  }

  void _onWebMessage(dynamic message) {
    final m = message is String ? (jsonDecode(message) as Map) : message as Map;
    if (m['k'] == 'flutter') return onMessage('${m['json']}');
    if (m['k'] == 'invoke') _invoke(m['id'] as int, '${m['cmd']}', Map<String, dynamic>.from((m['args'] as Map?) ?? const {}));
  }

  Future<void> _invoke(int id, String cmd, Map<String, dynamic> a) async {
    Object? out;
    var ok = true;
    try {
      out = await _command(cmd, a);
    } catch (e) {
      ok = false;
      out = '$e';
    }
    await _js('window.__carinoHost && __carinoHost.resolve($id, $ok, ${jsonEncode(out)})');
  }

  /// The engine's commands, by the names the earlier Windows app used.
  Future<Object?> _command(String cmd, Map<String, dynamic> a) async {
    String s(String k) => '${a[k] ?? ''}';
    switch (cmd) {
      case 'lan_addresses':
        return lanAddresses(_listener?.port ?? _syncPort);
      case 'sync_reply':
        _syncWaiting.remove(a['id'] as int)?.complete(s('body'));
        return null;
      case 'pick_folder':
        final dir = await FilePicker.getDirectoryPath(dialogTitle: 'Choose a folder Carino may read');
        return dir == null ? null : _folders.grant(dir);
      case 'forget_folder':
        _folders.forget(s('root'));
        return null;
      case 'fs_list':
        return _folders.list(s('root'), s('rel'));
      case 'fs_read':
        return _folders.read(s('root'), s('rel'), (a['maxBytes'] as num?)?.toInt() ?? 0);
      case 'fs_rename':
        _folders.rename(s('root'), s('rel'), s('toRel'));
        return null;
      case 'fs_write':
        _folders.write(s('root'), s('rel'), s('b64'));
        return null;
      case 'fs_delete_recover':
        return _folders.deleteRecover(s('root'), s('rel'), s('sha256Hex'));
      case 'fs_restore':
        _folders.restore(s('root'), s('rel'), s('recovery'), s('sha256Hex'));
        return null;
      case 'list_apps':
        return _apps.list;
      case 'pick_app':
        final r = await FilePicker.pickFile(dialogTitle: 'Choose an app Carino may open', type: FileType.custom, allowedExtensions: ['exe']);
        final path = r?.path;
        return path == null ? null : _apps.approve(path);
      case 'forget_app':
        _apps.forget(s('id'));
        return null;
      case 'open_app':
        await _apps.open(s('id'), a['root'] as String?, a['rel'] as String?);
        return null;
      case 'open_file':
        await _apps.openFile(s('root'), s('rel'));
        return null;
      case 'vault_seal':
        return vaultSeal(s('plain'));
      case 'vault_open':
        return vaultOpen(s('sealed'));
      case 'browser_open':
        return _agentOpen(s('url'));
      case 'browser_eval':
        final v = await (await _agentView()).executeScript(s('script'));
        return v is String ? v : jsonEncode(v);
      case 'browser_back':
        final c = await _agentView();
        final done = c.loadingState.firstWhere((st) => st == LoadingState.navigationCompleted).timeout(const Duration(seconds: 30));
        await c.goBack();
        await done;
        return null;
      case 'probe_local_ai':
        return probeLocalAi((a['port'] as num).toInt(), s('path'));
      default:
        throw HostError('Unknown command $cmd');
    }
  }

  /// The agent's hidden browser for websites: a separate WebView2 that never sees Carino's bridge.
  Future<WebviewController> _agentView() async {
    final existing = _agent;
    if (existing != null) return existing;
    final c = WebviewController();
    await c.initialize();
    await c.setPopupWindowPolicy(WebviewPopupWindowPolicy.deny);
    return _agent = c;
  }

  Future<String> _agentOpen(String url) async {
    final u = Uri.tryParse(url);
    if (u == null || !(u.scheme == 'https' || u.scheme == 'http')) throw const HostError('Only web pages can be opened.');
    final c = await _agentView();
    final done = c.loadingState.firstWhere((st) => st == LoadingState.navigationCompleted).timeout(const Duration(seconds: 45));
    await c.loadUrl(url);
    await done;
    // A little time for scripts that draw the page after loading.
    await Future<void>.delayed(const Duration(milliseconds: 600));
    return url;
  }

  @override
  bool get hasWebScreens => true;

  @override
  Future<String> startPath() async => '/';

  @override
  Future<void> openWebScreen(String path) => _js('window.dispatchEvent(new Event("carino-refresh")); window.__hn && __hn.open(${jsonEncode(path)})');

  @override
  Future<void> deliver(String json) => _js('window.__carinoFlutter && __carinoFlutter.request(${jsonEncode(json)})');

  @override
  Future<void> abortRequest(String id) => _js('window.__carinoFlutter && __carinoFlutter.abort(${jsonEncode(id)})');

  @override
  Future<void> reload() => controller.loadUrl('$_origin/?flutter=1');

  @override
  Future<void> openExternal(String url) async {
    final u = Uri.tryParse(url);
    if (u == null || !const {'https', 'http', 'mailto', 'tel', 'sms', 'geo'}.contains(u.scheme)) return;
    await launchUrl(u, mode: LaunchMode.externalApplication);
  }

  /// The browser comes back to a loopback address Carino listens on (as on the phone); the result
  /// goes to the engine as a "carino-oauth" event.
  @override
  Future<String?> signIn(String url) async {
    await _signIn?.close(force: true);
    try {
      _signIn = await HttpServer.bind(InternetAddress.loopbackIPv4, _loopbackPort);
    } catch (_) {
      return 'Couldn’t get ready for the sign-in. Close other Carino windows and try again.';
    }
    final server = _signIn!;
    Timer(const Duration(minutes: 10), () => server.close(force: true));
    server.listen((req) async {
      if (req.uri.path != '/callback') {
        req.response.statusCode = 404;
        await req.response.close();
        return;
      }
      req.response.headers.contentType = ContentType.html;
      req.response.write('<!doctype html><meta charset="utf-8"><title>Carino</title><body style="font-family:sans-serif;padding:40px">Signed in. You can close this tab and go back to Carino.</body>');
      await req.response.close();
      await server.close();
      await _js('window.__hn && __hn.oauth(${jsonEncode(req.uri.query)})');
    });
    await openExternal(url);
    return null;
  }

  Future<void> dispose() async {
    await _listener?.stop();
    await _signIn?.close(force: true);
    await _agent?.dispose();
    await controller.dispose();
  }
}
