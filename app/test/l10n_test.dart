import 'dart:convert';
import 'dart:io';

import 'package:carino/l10n.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => L10n.setWords('en', const {}));

  test('every language file is valid and keeps the {0} placeholders', () {
    final files = Directory('assets/i18n').listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList();
    expect(files.length, 7);
    final ph = RegExp(r'\{\d+\}');
    for (final f in files) {
      final words = (jsonDecode(f.readAsStringSync()) as Map).cast<String, String>();
      expect(words.length, greaterThan(600), reason: f.path);
      for (final MapEntry(:key, :value) in words.entries) {
        final need = ph.allMatches(key).map((m) => m[0]).toSet();
        final have = ph.allMatches(value).map((m) => m[0]).toSet();
        expect(have.difference(need), isEmpty, reason: '${f.path}: $key');
        if (need.contains('{0}')) expect(have, contains('{0}'), reason: '${f.path}: $key');
      }
    }
  });

  test('picks the phone language when the setting is automatic', () {
    expect(L10n.resolve('', const Locale('de', 'AT')), 'de');
    expect(L10n.resolve('', const Locale('pt', 'PT')), 'pt-BR');
    expect(L10n.resolve('', const Locale('sw')), 'en');
    expect(L10n.resolve('fr', const Locale('de')), 'fr');
  });

  testWidgets('text follows the chosen language, with values filled in', (tester) async {
    await tester.pumpWidget(L10nScope(child: const MaterialApp(home: Column(children: [Tx('Settings'), Tx('Ask {0} anything.', args: ['Carino'])]))));
    expect(find.text('Settings'), findsOneWidget);
    L10n.setWords('de', {'Settings': 'Einstellungen', 'Ask {0} anything.': 'Frag {0} irgendwas.'});
    await tester.pump();
    expect(find.text('Einstellungen'), findsOneWidget);
    expect(find.text('Frag Carino irgendwas.'), findsOneWidget);
    expect(tr('Not translated'), 'Not translated');
  });
}
