import 'dart:convert';
import 'dart:ui' show PlatformDispatcher, Locale;

import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter/widgets.dart';

/// Carino's languages. Text is written in English in the code; each screen looks its words up
/// here (assets/i18n/<code>.json, shared with the web app), falling back to English.
const appLanguages = <String, String>{
  '': 'Automatic (phone language)',
  'en': 'English',
  'pt-BR': 'Português (Brasil)',
  'de': 'Deutsch',
  'fr': 'Français',
  'es': 'Español',
  'nl': 'Nederlands',
  'it': 'Italiano',
  'pl': 'Polski',
};

class L10n {
  static Map<String, String> _words = const {};
  static String _code = 'en';
  static String _wanted = '\u0000';
  static final changes = ValueNotifier<String>('en');

  /// The language in use, e.g. "de" or "pt-BR".
  static String get code => _code;
  static Locale get locale => _code == 'pt-BR' ? const Locale('pt', 'BR') : Locale(_code);

  /// The language to use for a setting ('' = the phone's own language when Carino has it).
  static String resolve(String wanted, [Locale? device]) {
    if (wanted.isNotEmpty && appLanguages.containsKey(wanted)) return wanted;
    final d = device ?? PlatformDispatcher.instance.locale;
    if (d.languageCode == 'pt') return 'pt-BR';
    return appLanguages.containsKey(d.languageCode) ? d.languageCode : 'en';
  }

  /// Loads the words for a language setting (does nothing if it's already loaded).
  static Future<void> use(String wanted) async {
    if (wanted == _wanted) return;
    _wanted = wanted;
    final code = resolve(wanted);
    var words = const <String, String>{};
    if (code != 'en') {
      try {
        words = (jsonDecode(await rootBundle.loadString('assets/i18n/$code.json')) as Map).cast<String, String>();
      } catch (_) {
        words = const {};
      }
    }
    setWords(code, words);
  }

  /// For tests: use these words directly.
  static void setWords(String code, Map<String, String> words) {
    _code = code;
    _words = words;
    changes.value = code;
  }

  static String lookup(String key) => _words[key] ?? key;
}

/// A piece of English UI text in the user's language. `{0}`, `{1}` … are filled from [args].
String tr(String key, [List<Object?>? args]) {
  var s = L10n.lookup(key);
  if (args != null) {
    for (var i = 0; i < args.length; i++) {
      s = s.replaceAll('{$i}', '${args[i] ?? ''}');
    }
  }
  return s;
}

/// Text in the user's language (a drop-in for Text with the common options).
class Tx extends StatelessWidget {
  final String text;
  final List<Object?>? args;
  final TextStyle? style;
  final TextAlign? textAlign;
  final int? maxLines;
  final TextOverflow? overflow;
  final bool? softWrap;
  const Tx(this.text, {super.key, this.args, this.style, this.textAlign, this.maxLines, this.overflow, this.softWrap});

  @override
  Widget build(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<L10nScope>();
    return Text(tr(text, args), style: style, textAlign: textAlign, maxLines: maxLines, overflow: overflow, softWrap: softWrap);
  }
}

/// Rebuilds translated text when the language changes.
class L10nScope extends InheritedNotifier<ValueNotifier<String>> {
  L10nScope({super.key, required super.child}) : super(notifier: L10n.changes);
}
