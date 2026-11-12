import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

/// What Carino for Windows adds to the engine, in Dart (it was Rust in the earlier Tauri app):
/// folders and apps the user chose, the local-network sync listener, the PC's addresses for
/// pairing, and looking for AI servers on this PC. The engine calls these by the same command
/// names as before (see mobile/engine.ts), so nothing in the engine changes.
class HostError implements Exception {
  final String message;
  const HostError(this.message);
  @override
  String toString() => message;
}

/// Folders the user chose in Windows' own folder dialog, and nothing else. Every path is resolved
/// and must stay inside its folder (no "..", no links leading out).
class Folders {
  final Directory store;
  final List<String> grants = [];
  Folders(this.store) {
    try {
      final f = File(p.join(store.path, 'folders.json'));
      if (f.existsSync()) grants.addAll((jsonDecode(f.readAsStringSync()) as List).cast<String>());
    } catch (_) {}
  }

  void _save() {
    store.createSync(recursive: true);
    File(p.join(store.path, 'folders.json')).writeAsStringSync(jsonEncode(grants));
  }

  static String _real(String path) {
    final t = FileSystemEntity.typeSync(path);
    if (t == FileSystemEntityType.notFound) throw const HostError('That folder isn’t available.');
    return t == FileSystemEntityType.directory ? Directory(path).resolveSymbolicLinksSync() : File(path).resolveSymbolicLinksSync();
  }

  static bool _within(String child, String root) => p.equals(child, root) || p.isWithin(root, child);

  /// Adds a folder the user just picked; returns {root, label}.
  Map<String, String> grant(String picked) {
    final real = _real(picked);
    if (!grants.any((g) => p.equals(g, real))) {
      grants.add(real);
      _save();
    }
    final name = p.basename(real);
    return {'root': real, 'label': name.isEmpty ? real : name};
  }

  void forget(String root) {
    String? r;
    try {
      r = _real(root);
    } catch (_) {}
    grants.removeWhere((g) => p.equals(g, root) || (r != null && p.equals(g, r)));
    _save();
  }

  /// A path inside a chosen folder, or an error. [rel] uses "/" between parts.
  String inside(String root, String rel) {
    final realRoot = _real(root);
    if (!grants.any((g) {
      try {
        return p.equals(_real(g), realRoot);
      } catch (_) {
        return false;
      }
    })) {
      throw const HostError('That folder wasn’t chosen for Carino.');
    }
    final parts = rel.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).toList();
    if (parts.any((s) => s == '..' || s == '.' || s.contains(':')) || p.isAbsolute(rel)) throw const HostError('That path is outside the folder.');
    final target = p.joinAll([realRoot, ...parts]);
    // For a path that doesn't exist yet, check its nearest existing parent.
    var base = target;
    final rest = <String>[];
    while (FileSystemEntity.typeSync(base) == FileSystemEntityType.notFound) {
      rest.insert(0, p.basename(base));
      final up = p.dirname(base);
      if (up == base) throw const HostError('Bad path');
      base = up;
    }
    final real = p.joinAll([_real(base), ...rest]);
    if (!_within(real, realRoot)) throw const HostError('That path is outside the folder.');
    return real;
  }

  List<Map<String, Object>> list(String root, String rel) {
    final dir = inside(root, rel);
    final base = _real(root);
    final out = <Map<String, Object>>[];
    for (final e in Directory(dir).listSync(followLinks: false)) {
      final name = p.basename(e.path);
      if (name.startsWith('.')) continue;
      String real;
      try {
        real = _real(e.path);
      } catch (_) {
        continue;
      }
      if (!_within(real, base)) continue; // a link leading out of the folder
      final st = FileStat.statSync(real);
      out.add({
        'rel': p.split(p.relative(real, from: base)).join('/'),
        'name': name,
        'dir': st.type == FileSystemEntityType.directory,
        'size': st.size,
        'mtime': '${st.modified.millisecondsSinceEpoch}',
      });
    }
    return out;
  }

  String read(String root, String rel, int maxBytes) {
    final f = File(inside(root, rel));
    if (f.lengthSync() > maxBytes) throw const HostError('That file is too large to read.');
    return base64Encode(f.readAsBytesSync());
  }

  void rename(String root, String rel, String toRel) {
    final from = inside(root, rel);
    final to = inside(root, toRel);
    if (FileSystemEntity.typeSync(to) != FileSystemEntityType.notFound) throw HostError('There is already a file at $toRel.');
    Directory(p.dirname(to)).createSync(recursive: true);
    FileSystemEntity.isDirectorySync(from) ? Directory(from).renameSync(to) : File(from).renameSync(to);
  }

  /// Writes a new file (approved in the app first); never replaces an existing one.
  void write(String root, String rel, String b64) {
    final to = inside(root, rel);
    if (FileSystemEntity.typeSync(to) != FileSystemEntityType.notFound) throw HostError('There is already a file at $rel.');
    Directory(p.dirname(to)).createSync(recursive: true);
    final raf = File(to).openSync(mode: FileMode.writeOnly);
    try {
      raf.writeFromSync(base64Decode(b64));
    } finally {
      raf.closeSync();
    }
  }

  static String _sha(List<int> b) => sha256.convert(b).toString();

  /// Deletes a file after copying it to Carino's recovery folder and checking the copy.
  String deleteRecover(String root, String rel, String sha256Hex) {
    final path = inside(root, rel);
    final bytes = File(path).readAsBytesSync();
    if (_sha(bytes) != sha256Hex) throw HostError('$rel changed since it was checked. Look again before deleting it.');
    final dir = Directory(p.join(store.path, 'recovery'))..createSync(recursive: true);
    final copy = File(p.join(dir.path, '${DateTime.now().microsecondsSinceEpoch}-${_sha(utf8.encode(path)).substring(0, 12)}.bin'));
    copy.writeAsBytesSync(bytes, flush: true);
    if (_sha(copy.readAsBytesSync()) != sha256Hex) {
      copy.deleteSync();
      throw const HostError('The safety copy didn’t check out, so nothing was deleted.');
    }
    File(path).deleteSync();
    return copy.path;
  }

  void restore(String root, String rel, String recovery, String sha256Hex) {
    final recDir = Directory(p.join(store.path, 'recovery'));
    if (!recDir.existsSync()) throw const HostError('The saved copy is missing.');
    final real = File(recovery).existsSync() ? File(recovery).resolveSymbolicLinksSync() : throw const HostError('The saved copy is missing.');
    if (!p.isWithin(recDir.resolveSymbolicLinksSync(), real)) throw const HostError('That isn’t one of Carino’s saved copies.');
    final bytes = File(real).readAsBytesSync();
    if (_sha(bytes) != sha256Hex) throw const HostError('The saved copy is damaged; it can’t be restored.');
    final to = inside(root, rel);
    if (FileSystemEntity.typeSync(to) != FileSystemEntityType.notFound) throw HostError('There is already a file at $rel.');
    Directory(p.dirname(to)).createSync(recursive: true);
    File(to).writeAsBytesSync(bytes, flush: true);
    if (_sha(File(to).readAsBytesSync()) != sha256Hex) throw const HostError('The restored file didn’t check out.');
    File(real).deleteSync();
  }
}

/// Files that would run code if "opened": refused.
const _runnable = {'exe', 'bat', 'cmd', 'com', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'scr', 'pif', 'lnk', 'reg', 'jar', 'cpl', 'msc', 'appref-ms', 'url', 'inf', 'dll', 'sys'};
bool isRunnable(String path) => _runnable.contains(p.extension(path).replaceFirst('.', '').toLowerCase());

/// Apps on this PC the user approved one at a time. Carino can open only those (optionally with a
/// file from a chosen folder), and open files from chosen folders with their usual app.
class Apps {
  final Directory store;
  final Folders folders;
  final List<Map<String, String>> list = [];
  Apps(this.store, this.folders) {
    try {
      final f = File(p.join(store.path, 'apps.json'));
      if (f.existsSync()) list.addAll((jsonDecode(f.readAsStringSync()) as List).map((e) => Map<String, String>.from(e as Map)));
    } catch (_) {}
  }

  void _save() {
    store.createSync(recursive: true);
    File(p.join(store.path, 'apps.json')).writeAsStringSync(jsonEncode(list));
  }

  Map<String, String> approve(String exe) {
    final a = {'id': '${DateTime.now().microsecondsSinceEpoch}', 'name': p.basenameWithoutExtension(exe), 'path': exe};
    list
      ..removeWhere((x) => x['path'] == exe)
      ..add(a);
    _save();
    return a;
  }

  void forget(String id) {
    list.removeWhere((x) => x['id'] == id);
    _save();
  }

  /// Starts the program directly (no shell), so nothing in a file name can become a command.
  Future<void> open(String id, String? root, String? rel) async {
    final a = list.where((x) => x['id'] == id).firstOrNull ?? (throw const HostError('That app isn’t one you approved for Carino.'));
    final args = root != null && rel != null ? [folders.inside(root, rel)] : <String>[];
    try {
      await Process.start(a['path']!, args, mode: ProcessStartMode.detached, runInShell: false);
    } catch (e) {
      throw HostError('Couldn’t open ${a['name']}: $e');
    }
  }

  /// Opens a file from a chosen folder with its usual app (never a program or script).
  Future<void> openFile(String root, String rel) async {
    final path = folders.inside(root, rel);
    if (isRunnable(path)) throw const HostError('Carino doesn’t open programs or scripts.');
    if (Platform.isWindows) {
      // "explorer.exe <file>" opens it with its usual app, without a shell parsing the name.
      await Process.start('explorer.exe', [path], mode: ProcessStartMode.detached);
    } else {
      await Process.start(Platform.isMacOS ? 'open' : 'xdg-open', [path], mode: ProcessStartMode.detached);
    }
  }
}

/// AI servers on this PC (Ollama, LM Studio, llama.cpp): only 127.0.0.1, these ports, these two
/// read-only listings, only GET.
const aiPorts = {11434, 1234, 8080};
const aiPaths = {'/api/tags', '/v1/models'};
bool aiAllowed(int port, String path) => aiPorts.contains(port) && aiPaths.contains(path);

Future<String?> probeLocalAi(int port, String path) async {
  if (!aiAllowed(port, path)) throw const HostError('Not an AI server port or listing.');
  final client = HttpClient()..connectionTimeout = const Duration(milliseconds: 800);
  try {
    final req = await client.getUrl(Uri(scheme: 'http', host: '127.0.0.1', port: port, path: path));
    req.followRedirects = false;
    final res = await req.close().timeout(const Duration(seconds: 3));
    if (res.statusCode != 200) return null;
    final bytes = <int>[];
    await for (final chunk in res.timeout(const Duration(seconds: 3))) {
      bytes.addAll(chunk);
      if (bytes.length > 1 << 20) break;
    }
    return utf8.decode(bytes, allowMalformed: true);
  } catch (_) {
    return null; // nothing running there
  } finally {
    client.close(force: true);
  }
}

/// This PC's addresses on private networks (what the phone can reach), for the pairing QR code.
List<String> privateAddresses(int port, Iterable<InternetAddress> candidates) => [
      for (final a in candidates)
        if (a.type == InternetAddressType.IPv4 && !a.isLoopback && _isPrivate(a.rawAddress)) 'http://${a.address}:$port',
    ];

bool _isPrivate(List<int> b) => b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168);

Future<List<String>> lanAddresses(int port) async {
  final ifs = await NetworkInterface.list(includeLoopback: false, type: InternetAddressType.IPv4);
  return privateAddresses(port, ifs.expand((i) => i.addresses));
}

/// The local-network endpoint a paired phone syncs with. It only moves bytes: every request is
/// encrypted with the pair's key and the engine opens and answers it. Anything that isn't
/// POST /carino-sync is refused, bodies are capped, and each address is rate-limited.
class SyncListener {
  static const defaultPort = 47900;
  static const maxBody = 64 * 1024 * 1024;
  static const perMinute = 120;

  final HttpServer _server;
  final Future<String> Function(String body) handler;
  final _seen = <String, (DateTime, int)>{};

  SyncListener._(this._server, this.handler) {
    _server.listen(_serve);
  }

  int get port => _server.port;

  static Future<SyncListener> start(Future<String> Function(String body) handler, {Object? address, int port = defaultPort}) async =>
      SyncListener._(await HttpServer.bind(address ?? InternetAddress.anyIPv4, port), handler);

  Future<void> stop() => _server.close(force: true);

  bool _allow(String ip) {
    final now = DateTime.now();
    if (_seen.length > 10000) _seen.clear();
    var (since, n) = _seen[ip] ?? (now, 0);
    if (now.difference(since) > const Duration(seconds: 60)) (since, n) = (now, 0);
    _seen[ip] = (since, n + 1);
    return n + 1 <= perMinute;
  }

  Future<void> _serve(HttpRequest req) async {
    final res = req.response..headers.contentType = ContentType.json;
    Future<void> reply(int status, Object body) async {
      res.statusCode = status;
      res.write(body is String ? body : jsonEncode(body));
      await res.close();
    }

    try {
      if (req.method != 'POST' || req.uri.path != '/carino-sync' || req.uri.hasQuery) return await reply(404, {'ok': false, 'error': 'Not found'});
      if (!_allow(req.connectionInfo?.remoteAddress.address ?? '?')) return await reply(429, {'ok': false, 'error': 'Too many requests'});
      if (req.contentLength > maxBody) return await reply(413, {'ok': false, 'error': 'Too large'});
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in req) {
        bytes.add(chunk);
        if (bytes.length > maxBody) return await reply(413, {'ok': false, 'error': 'Too large'});
      }
      String body;
      try {
        body = utf8.decode(bytes.takeBytes());
      } catch (_) {
        return await reply(413, {'ok': false, 'error': 'Too large or not text'});
      }
      try {
        return await reply(200, await handler(body).timeout(const Duration(seconds: 60)));
      } catch (e) {
        return await reply(503, {'ok': false, 'error': e is TimeoutException ? 'Carino on the PC didn’t answer in time' : '$e'});
      }
    } catch (_) {
      try {
        await res.close();
      } catch (_) {}
    }
  }
}
