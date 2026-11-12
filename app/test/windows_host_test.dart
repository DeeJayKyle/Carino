import 'dart:convert';
import 'dart:io';

import 'package:carino/windows/host.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory base;
  setUp(() => base = Directory.systemTemp.createTempSync('carino-host-'));
  tearDown(() => base.deleteSync(recursive: true));

  test('only chosen folders, and only inside them', () {
    final chosen = Directory(p.join(base.path, 'Documents'))..createSync();
    final other = Directory(p.join(base.path, 'Private'))..createSync();
    File(p.join(chosen.path, 'a.txt')).writeAsStringSync('a');
    File(p.join(other.path, 'secret.txt')).writeAsStringSync('s');
    final f = Folders(Directory(p.join(base.path, 'store')));
    final root = f.grant(chosen.path)['root']!;
    expect(f.inside(root, 'a.txt'), endsWith('a.txt'));
    expect(f.inside(root, 'New folder/b.txt'), contains('New folder'));
    expect(() => f.inside(root, '../Private/secret.txt'), throwsA(isA<HostError>()));
    expect(() => f.inside(other.path, 'secret.txt'), throwsA(isA<HostError>()));
    if (!Platform.isWindows) {
      Link(p.join(chosen.path, 'link.txt')).createSync(p.join(other.path, 'secret.txt'));
      expect(() => f.inside(root, 'link.txt'), throwsA(isA<HostError>()));
      expect(f.list(root, '').map((e) => e['name']), isNot(contains('link.txt')));
    }
    // Remembered across restarts, and forgotten on request.
    expect(Folders(Directory(p.join(base.path, 'store'))).grants, [root]);
    f.forget(root);
    expect(() => f.inside(root, 'a.txt'), throwsA(isA<HostError>()));
  });

  test('delete keeps a checked copy that restores', () {
    final chosen = Directory(p.join(base.path, 'Docs'))..createSync();
    File(p.join(chosen.path, 'x.txt')).writeAsStringSync('hello');
    final f = Folders(Directory(p.join(base.path, 'store')));
    final root = f.grant(chosen.path)['root']!;
    final sha = sha256.convert(utf8.encode('hello')).toString();
    expect(() => f.deleteRecover(root, 'x.txt', 'bad'), throwsA(isA<HostError>()));
    final copy = f.deleteRecover(root, 'x.txt', sha);
    expect(File(p.join(chosen.path, 'x.txt')).existsSync(), isFalse);
    expect(() => f.restore(root, 'x.txt', p.join(chosen.path, 'nope.bin'), sha), throwsA(isA<HostError>()));
    f.restore(root, 'x.txt', copy, sha);
    expect(File(p.join(chosen.path, 'x.txt')).readAsStringSync(), 'hello');
    f.write(root, 'new/y.txt', base64Encode(utf8.encode('y')));
    expect(() => f.write(root, 'new/y.txt', ''), throwsA(isA<HostError>()));
    expect(f.read(root, 'new/y.txt', 10), base64Encode(utf8.encode('y')));
  });

  test('programs and scripts are never opened', () {
    for (final n in ['setup.exe', 'run.BAT', 'x.ps1', 'a.lnk', 'b.js', 'c.hta', 'd.reg']) {
      expect(isRunnable(n), isTrue, reason: n);
    }
    for (final n in ['Budget.xlsx', 'letter.docx', 'scan.pdf', 'photo.jpg', 'notes.txt']) {
      expect(isRunnable(n), isFalse, reason: n);
    }
  });

  test('looks only for AI listings on known ports', () async {
    expect(aiAllowed(11434, '/api/tags'), isTrue);
    expect(aiAllowed(1234, '/v1/models'), isTrue);
    expect(aiAllowed(22, '/v1/models'), isFalse);
    expect(aiAllowed(11434, '/api/generate'), isFalse);
    await expectLater(probeLocalAi(22, '/v1/models'), throwsA(isA<HostError>()));
  });

  test('offers only private network addresses', () {
    final ips = ['192.168.1.20', '10.0.0.5', '127.0.0.1', '8.8.8.8', '172.20.1.1', '172.32.0.1'].map(InternetAddress.new);
    expect(privateAddresses(47900, ips), ['http://192.168.1.20:47900', 'http://10.0.0.5:47900', 'http://172.20.1.1:47900']);
  });

  test('sync listener passes requests to the app and refuses everything else', () async {
    var fail = false;
    final l = await SyncListener.start((b) async => fail ? throw 'The app is closed' : '{"echo":$b}', address: InternetAddress.loopbackIPv4, port: 0);
    final c = HttpClient();
    Future<(int, String)> send(String method, String path, [String body = '']) async {
      final r = await c.openUrl(method, Uri.parse('http://127.0.0.1:${l.port}$path'));
      r.write(body);
      final res = await r.close();
      return (res.statusCode, await utf8.decodeStream(res));
    }

    expect(await send('POST', '/carino-sync', '{"v":1}'), (200, '{"echo":{"v":1}}'));
    expect((await send('POST', '/')).$1, 404);
    expect((await send('GET', '/carino-sync')).$1, 404);
    fail = true;
    final (s, b) = await send('POST', '/carino-sync', '{}');
    expect(s, 503);
    expect(b, contains('The app is closed'));
    var limited = 0;
    for (var i = 0; i < SyncListener.perMinute; i++) {
      if ((await send('POST', '/carino-sync', '{}')).$1 == 429) limited++;
    }
    expect(limited, 2); // 120 allowed per minute; 122 sent in all
    c.close(force: true);
    await l.stop();
  });
}
