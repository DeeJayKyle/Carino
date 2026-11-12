import 'package:flutter/material.dart';
import '../l10n.dart';

import '../engine/engine.dart';

/// Loads something from the engine and shows loading, error (with retry) or the result.
class Loader<T> extends StatefulWidget {
  final Future<T> Function() load;
  final Widget Function(BuildContext, T, Future<void> Function() reload) builder;
  /// Changing this reloads (e.g. AppState.revision).
  final Object? reloadKey;
  const Loader({super.key, required this.load, required this.builder, this.reloadKey});

  @override
  State<Loader<T>> createState() => _LoaderState<T>();
}

class _LoaderState<T> extends State<Loader<T>> {
  T? _data;
  Object? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  @override
  void didUpdateWidget(covariant Loader<T> old) {
    super.didUpdateWidget(old);
    if (old.reloadKey != widget.reloadKey) _reload();
  }

  Future<void> _reload() async {
    setState(() => _loading = _data == null);
    try {
      final d = await widget.load();
      if (mounted) setState(() { _data = d; _error = null; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = e; _loading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _data == null) return const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()));
    if (_error != null && _data == null) return ErrorPanel(error: _error!, retry: _reload);
    return widget.builder(context, _data as T, _reload);
  }
}

class ErrorPanel extends StatelessWidget {
  final Object error;
  final VoidCallback retry;
  const ErrorPanel({super.key, required this.error, required this.retry});

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.error_outline, color: Theme.of(context).colorScheme.error),
            const SizedBox(height: 8),
            Text(error is ApiError ? (error as ApiError).message : 'Something went wrong.', textAlign: TextAlign.center),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: retry, child: const Tx('Try again')),
          ]),
        ),
      );
}

void toast(BuildContext context, String text, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text), backgroundColor: error ? Theme.of(context).colorScheme.error : null));
}

String errorText(Object e) => e is ApiError ? e.message : 'Something went wrong.';

/// "in 5 min", "2 h ago", "yesterday" — short relative times.
String relativeTime(String? iso, {DateTime? now}) {
  if (iso == null) return '';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '';
  final n = now ?? DateTime.now();
  final d = n.difference(t);
  if (d.inMinutes.abs() < 1) return 'just now';
  if (d.isNegative) {
    final a = d.abs();
    if (a.inMinutes < 60) return 'in ${a.inMinutes} min';
    if (a.inHours < 24) return 'in ${a.inHours} h';
    return 'in ${a.inDays} d';
  }
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  if (d.inDays == 1) return 'yesterday';
  return '${d.inDays} d ago';
}
