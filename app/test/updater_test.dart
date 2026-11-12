import 'package:carino/update/updater.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('compares versions part by part', () {
    expect(compareVersions('1.6.10', '1.6.9'), 1);
    expect(compareVersions('v1.7.0', '1.6.99'), 1);
    expect(compareVersions('1.6.0', '1.6.0+10600'), 0);
    expect(compareVersions('1.5.9', '1.6.0'), -1);
  });

  test('picks the right download for each device', () {
    final assets = [
      {'name': 'Carino-1.7.0.apk', 'browser_download_url': 'a'},
      {'name': 'Carino-Setup-1.7.0.exe', 'browser_download_url': 'w'},
      {'name': 'notes.txt'},
    ];
    expect(assetFor(assets, windows: false)?['browser_download_url'], 'a');
    expect(assetFor(assets, windows: true)?['browser_download_url'], 'w');
    expect(assetFor([{'name': 'other.zip'}], windows: true), isNull);
  });
}
