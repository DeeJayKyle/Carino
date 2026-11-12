import 'dart:async';

import 'package:flutter/foundation.dart';

import '../engine/device.dart';
import '../engine/engine.dart';

/// Speech to text with the phone's own recognition (through the engine). With [continuous], it keeps
/// listening across pauses until [stop].
class Dictation extends ChangeNotifier {
  final Engine engine;
  final Device device;
  final void Function(String text) onFinal;
  final bool continuous;
  String lang;

  bool listening = false;
  String interim = '';
  String? error;
  bool _wanted = false;
  StreamSubscription<EngineEvent>? _sub;

  Dictation({required this.engine, required this.device, required this.onFinal, this.lang = 'en-US', this.continuous = false});

  Future<void> start() async {
    error = null;
    _wanted = continuous;
    listening = true;
    notifyListeners();
    _sub ??= engine.events.where((e) => e.name == 'speech').listen((e) => _on(e.data));
    try {
      await device.listen(lang);
    } catch (e) {
      listening = false;
      error = 'Voice input isn’t available here.';
      notifyListeners();
    }
  }

  Future<void> stop() async {
    _wanted = false;
    await device.stopListening().catchError((_) {});
  }

  void _on(Map<String, dynamic> e) {
    if (e['partial'] != null) interim = '${e['partial']}';
    final fin = e['final'] as String?;
    if (fin != null && fin.trim().isNotEmpty) {
      interim = '';
      onFinal(fin.trim());
    }
    final err = e['error'] as String?;
    if (err != null && !(err == 'no-speech' && _wanted)) {
      _wanted = false;
      error = err == 'not-allowed'
          ? 'Microphone access was blocked. Allow it for Carino in your phone’s settings.'
          : err == 'no-speech'
              ? 'No speech was heard. Try again.'
              : 'Voice input error: $err';
    }
    if (e['end'] == true) {
      interim = '';
      // Android ends each session after a pause; keep going for continuous dictation.
      if (_wanted) {
        device.listen(lang).catchError((_) {});
      } else {
        listening = false;
      }
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _wanted = false;
    if (listening) device.stopListening().catchError((_) {});
    _sub?.cancel();
    super.dispose();
  }
}
