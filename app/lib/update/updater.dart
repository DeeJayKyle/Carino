import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path/path.dart' as p;

/// Carino keeps itself up to date from its own GitHub releases. A new version is downloaded,
/// checked against the SHA-256 GitHub publishes for it, then installed: on Windows quietly (the
/// installer closes and restarts Carino); on Android, Android's own installer asks the user to
/// confirm and only accepts it if it is signed with Carino's key. Data is kept either way.
class Update {
  final String version;
  final String notes;
  final String url;
  final String? sha256;
  final String name;
  const Update(this.version, this.notes, this.url, this.sha256, this.name);
}

class UpdateError implements Exception {
  final String message;
  const UpdateError(this.message);
  @override
  String toString() => message;
}

const _releases = 'https://api.github.com/repos/DeeJayKyle/Carino/releases/latest';
const _channel = MethodChannel('carino/engine');

/// "1.6.10" > "1.6.9": compares version numbers part by part.
int compareVersions(String a, String b) {
  List<int> parts(String v) => v.replaceFirst(RegExp(r'^v'), '').split(RegExp(r'[.+-]')).take(3).map((x) => int.tryParse(x) ?? 0).toList();
  final x = parts(a), y = parts(b);
  for (var i = 0; i < 3; i++) {
    final d = (i < x.length ? x[i] : 0) - (i < y.length ? y[i] : 0);
    if (d != 0) return d.sign;
  }
  return 0;
}

/// The asset for this device in a release's asset list, if any.
Map? assetFor(List assets, {required bool windows}) {
  for (final a in assets.cast<Map>()) {
    final n = '${a['name']}';
    if (windows ? RegExp(r'^Carino-Setup-.*\.exe$').hasMatch(n) : RegExp(r'^Carino-.*\.apk$').hasMatch(n)) return a;
  }
  return null;
}

Future<String> currentVersion() async => (await PackageInfo.fromPlatform()).version;

/// The newer release for this device, or null when Carino is up to date.
Future<Update?> checkForUpdate({String? current, HttpClient? client}) async {
  if (!Platform.isAndroid && !Platform.isWindows) return null;
  final http = client ?? HttpClient();
  try {
    final req = await http.getUrl(Uri.parse(_releases));
    req.headers.set('accept', 'application/vnd.github+json');
    req.headers.set('user-agent', 'Carino-updater');
    final res = await req.close().timeout(const Duration(seconds: 20));
    if (res.statusCode != 200) return null;
    final rel = jsonDecode(await utf8.decodeStream(res)) as Map;
    if (rel['draft'] == true || rel['prerelease'] == true) return null;
    final version = '${rel['tag_name']}'.replaceFirst(RegExp(r'^v'), '');
    if (compareVersions(version, current ?? await currentVersion()) <= 0) return null;
    final asset = assetFor((rel['assets'] as List?) ?? const [], windows: Platform.isWindows);
    if (asset == null) return null;
    final digest = '${asset['digest'] ?? ''}';
    return Update(version, '${rel['body'] ?? ''}', '${asset['browser_download_url']}', digest.startsWith('sha256:') ? digest.substring(7) : null, '${asset['name']}');
  } finally {
    if (client == null) http.close();
  }
}

/// Downloads an update and checks it. Returns the file.
Future<File> download(Update u, {void Function(double)? progress}) async {
  final dir = Platform.isAndroid ? Directory(await _channel.invokeMethod<String>('updateDir') ?? Directory.systemTemp.path) : Directory(p.join(Directory.systemTemp.path, 'carino-update'));
  dir.createSync(recursive: true);
  final file = File(p.join(dir.path, u.name));
  final http = HttpClient();
  try {
    final req = await http.getUrl(Uri.parse(u.url));
    req.headers.set('user-agent', 'Carino-updater');
    final res = await req.close();
    if (res.statusCode != 200) throw UpdateError('The download didn’t work (${res.statusCode}).');
    final total = res.contentLength;
    final sink = file.openWrite();
    var got = 0;
    final hash = AccumulatorSink<Digest>();
    final hasher = sha256.startChunkedConversion(hash);
    await for (final chunk in res) {
      sink.add(chunk);
      hasher.add(chunk);
      got += chunk.length;
      if (total > 0) progress?.call(got / total);
    }
    await sink.close();
    hasher.close();
    final sum = hash.events.single.toString();
    if (u.sha256 == null || sum != u.sha256) {
      file.deleteSync();
      throw const UpdateError('The download didn’t match its checksum, so it was thrown away.');
    }
    return file;
  } finally {
    http.close();
  }
}

/// Installs a downloaded, checked update. Windows: quiet install, Carino closes and reopens.
/// Android: Android's installer asks the user. Returns false when Android first needs the
/// "install unknown apps" permission (its settings page is opened).
Future<bool> install(File f) async {
  if (Platform.isWindows) {
    await Process.start(f.path, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/RESTARTAPPLICATIONS'], mode: ProcessStartMode.detached);
    exit(0);
  }
  final r = await _channel.invokeMethod<String>('installApk', {'path': f.path});
  return r != 'needs_permission';
}

/// A sink that keeps the digest the hasher produces.
class AccumulatorSink<T> implements Sink<T> {
  final events = <T>[];
  @override
  void add(T event) => events.add(event);
  @override
  void close() {}
}
