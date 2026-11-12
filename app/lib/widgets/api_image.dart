import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../app_state.dart';

/// A picture served by Carino's engine (e.g. "/documents/ID/preview"), loaded through the engine.
class ApiImage extends StatefulWidget {
  final String path;
  final double? width;
  final double? height;
  final BoxFit fit;
  const ApiImage(this.path, {super.key, this.width, this.height, this.fit = BoxFit.cover});
  @override
  State<ApiImage> createState() => _ApiImageState();
}

class _ApiImageState extends State<ApiImage> {
  static final _cache = <String, Uint8List>{};
  Uint8List? _bytes;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _bytes = _cache[widget.path];
    if (_bytes == null) _load();
  }

  Future<void> _load() async {
    try {
      final r = await AppState.read(context).engine.send('GET', widget.path);
      final b = r.bytes;
      if (!r.ok || b == null) throw Exception('no image');
      final bytes = Uint8List.fromList(b);
      if (_cache.length > 60) _cache.remove(_cache.keys.first);
      _cache[widget.path] = bytes;
      if (mounted) setState(() => _bytes = bytes);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final b = _bytes;
    final box = SizedBox(width: widget.width, height: widget.height);
    if (b != null) return Image.memory(b, width: widget.width, height: widget.height, fit: widget.fit, gaplessPlayback: true);
    if (_failed) return SizedBox(width: widget.width, height: widget.height, child: const Icon(Icons.broken_image_outlined));
    return box;
  }
}
