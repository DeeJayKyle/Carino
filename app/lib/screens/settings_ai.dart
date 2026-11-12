import 'dart:async';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';

String _gb(num n) => n >= 1e9 ? '${(n / 1e9).toStringAsFixed(1)} GB' : '${(n / 1e6).round()} MB';

/// The AI service Carino uses: pick one, paste its key, choose a model, test it.
class AiSettings extends StatefulWidget {
  /// In onboarding: no app bar, no link to the full Connections page, and [onSaved] after a good test.
  final bool compact;
  final VoidCallback? onSaved;
  const AiSettings({super.key, this.compact = false, this.onSaved});
  @override
  State<AiSettings> createState() => _AiSettingsState();
}

class _AiSettingsState extends State<AiSettings> {
  List<Map>? _presets;
  Map<String, dynamic> _form = {};
  String? _protection;
  bool _keysUnreadable = false;
  Set<String>? _live;
  String? _liveError;
  List<Map>? _speed;
  bool _busy = false;
  bool _timing = false;
  bool _localReady = false;
  (bool, String)? _test;
  final _key = TextEditingController();
  final _url = TextEditingController();
  final _groq = TextEditingController();
  final _brave = TextEditingController();
  final _searx = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await AppState.read(context).api.get('/device/config') as Map;
    if (!mounted) return;
    final presets = (r['presets'] as List).cast<Map>();
    final cfg = Map<String, dynamic>.from(r['config'] as Map);
    setState(() {
      _presets = presets;
      _form = {...cfg, 'provider': cfg['provider'] ?? presets.first['id']};
      _protection = r['protection'] as String?;
      _keysUnreadable = r['keysUnreadable'] == true;
      _key.text = '${cfg['apiKey'] ?? ''}';
      _url.text = '${cfg['baseUrl'] ?? ''}';
      _groq.text = '${cfg['groqKey'] ?? ''}';
      _brave.text = '${cfg['braveKey'] ?? ''}';
      _searx.text = '${cfg['searxngUrl'] ?? ''}';
    });
  }

  Map get _p => _presets!.firstWhere((x) => x['id'] == _form['provider'], orElse: () => _presets!.first);
  String get _current => '${(_form['model'] ?? '').toString().isEmpty ? _p['model'] : _form['model']}';
  Map<String, dynamic> get _body => {..._form, 'apiKey': _key.text.trim(), 'baseUrl': _url.text.trim(), 'groqKey': _groq.text.trim(), 'braveKey': _brave.text.trim(), 'searxngUrl': _searx.text.trim()};

  Future<void> _check() async {
    setState(() => _busy = true);
    try {
      final r = await AppState.read(context).api.post('/device/models', {'provider': _p['id'], 'apiKey': _key.text.trim(), 'baseUrl': _url.text.trim()}) as Map;
      final ids = {...((r['models'] as List?) ?? const []).map((e) => '$e')};
      setState(() {
        _live = ids;
        _liveError = r['error'] as String?;
        if (ids.isNotEmpty && !ids.contains(_current)) {
          final best = (_p['models'] as List).cast<Map>().map((m) => '${m['id']}').where(ids.contains).firstOrNull ?? (_p['ownAddress'] == true || _p['id'] == 'openrouter' ? ids.first : null);
          if (best != null) _form['model'] = best;
        }
      });
    } catch (e) {
      setState(() { _live = {}; _liveError = errorText(e); });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _speedTest() async {
    setState(() { _timing = true; _speed = null; });
    try {
      final listed = (_p['models'] as List).cast<Map>().map((m) => '${m['id']}');
      final models = _live == null ? null : [...listed.where(_live!.contains), ..._extra].take(8).toList();
      final r = await AppState.read(context).api.post('/device/speedtest', {'provider': _p['id'], 'apiKey': _key.text.trim(), 'baseUrl': _url.text.trim(), 'models': ?models}) as Map;
      final results = (r['results'] as List).cast<Map>();
      setState(() {
        _speed = results;
        final best = results.where((x) => x['ok'] == true).firstOrNull;
        if (best != null) _form['model'] = best['model'];
      });
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _timing = false);
    }
  }

  List<String> get _extra => _live == null ? const [] : _live!.where((id) => !(_p['models'] as List).any((m) => (m as Map)['id'] == id) && (_p['id'] == 'openrouter' || _p['ownAddress'] == true)).toList();

  Future<void> _save() async {
    final app = AppState.read(context);
    setState(() { _busy = true; _test = null; });
    try {
      await app.api.put('/device/config', {..._body, 'model': (_form['model'] ?? '').toString().isEmpty ? null : _form['model']});
      await app.loadMe();
      final r = await app.api.post('/ai/test', {}).catchError((e) => {'results': [{'ok': false, 'error': errorText(e)}]}) as Map;
      final results = (r['results'] as List? ?? const []).cast<Map>();
      final res = results.where((x) => x['ok'] == true).firstOrNull ?? results.firstOrNull;
      if (res?['ok'] == true) widget.onSaved?.call();
      setState(() => _test = res?['ok'] == true ? (true, 'Connected to ${_p['label']} · ${res!['model']}') : (false, '${res?['error'] ?? 'Could not reach the AI service.'}'));
      app.changed();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final t = Theme.of(context).textTheme;
    if (_presets == null && widget.compact) return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
    if (_presets == null) return Scaffold(appBar: AppBar(title: const Tx('AI service')), body: const Center(child: CircularProgressIndicator()));
    final p = _p;
    final shown = _presets!.where((x) => x['hidden'] != true || x['id'] == _form['provider']).toList();
    final models = (p['models'] as List).cast<Map>();
    String mark(String id) => _live == null ? '' : _live!.contains(id) ? ' ✓' : (p['ownAddress'] == true ? ' — not installed' : ' — not available to this key');
    final needsKey = p['keyUrl'] != null && '${p['keyUrl']}'.isNotEmpty && p['ownAddress'] != true;
    final list = ListView(shrinkWrap: widget.compact, physics: widget.compact ? const NeverScrollableScrollPhysics() : null, padding: widget.compact ? EdgeInsets.zero : const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
        Tx('Carino asks an AI service to write its replies. Groq, Google Gemini and OpenRouter have free tiers — pick one and paste its key. Or download a small AI that runs on the phone itself.', style: TextStyle(color: cs.onSurfaceVariant)),
        if (_keysUnreadable) Card(color: Colors.orange.withValues(alpha: 0.12), margin: const EdgeInsets.only(top: 10), child: const ListTile(leading: Icon(Icons.warning_amber), title: Tx('Your saved keys couldn’t be unlocked on this device (its secure key store was reset). Please enter them again.'))),
        const SizedBox(height: 12),
        for (final (i, x) in shown.indexed)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            color: x['id'] == _form['provider'] ? cs.primaryContainer : null,
            child: ListTile(
              title: Row(children: [
                Flexible(child: Text('${x['label']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                const SizedBox(width: 6),
                if (x['hidden'] != true) Text(x['paid'] == true ? 'Paid' : i == 0 ? 'Free · best' : 'Free', style: TextStyle(fontSize: 11, color: x['paid'] == true ? Colors.orange : Colors.green, fontWeight: FontWeight.w700)),
              ]),
              subtitle: Text('${x['free']}', style: const TextStyle(fontSize: 12)),
              onTap: () => setState(() {
                _form = {..._form, 'provider': x['id'], 'model': ''};
                if (x['ownAddress'] != true) _url.text = '';
                _live = null;
                _speed = null;
                _test = null;
              }),
            ),
          ),
        const SizedBox(height: 6),
        if (p['onDevice'] == true)
          _LocalModels(value: _current, onChange: (id) => setState(() => _form['model'] = id), onReady: (ok) => _localReady != ok ? WidgetsBinding.instance.addPostFrameCallback((_) => setState(() => _localReady = ok)) : null)
        else ...[
          if (needsKey) TextButton.icon(onPressed: () => Device(AppState.read(context).api).openExternal('${p['keyUrl']}'), icon: const Icon(Icons.open_in_new, size: 16), label: Tx('Get a free key: {0}', args: ['${p['keyUrl']}'.replaceFirst('https://', '')])),
          if (p['ownAddress'] == true) TextField(controller: _url, keyboardType: TextInputType.url, decoration: InputDecoration(labelText: tr('Address'), hintText: '${p['baseUrl']}')),
          const SizedBox(height: 10),
          TextField(controller: _key, obscureText: true, autocorrect: false, decoration: InputDecoration(labelText: tr('API key{0}', [p['ownAddress'] == true ? ' (if needed)' : '']), hintText: tr('Paste your key'))),
          if (_protection != null) Padding(padding: const EdgeInsets.only(top: 4), child: Tx('🔒 {0} Only the last 4 characters are ever shown.', args: [_protection == 'android-keystore' ? 'Keys are encrypted and locked with your phone’s secure key store.' : 'Keys are stored encrypted on this device.'], style: t.bodySmall)),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            initialValue: models.any((m) => m['id'] == _current) || _extra.contains(_current) ? _current : null,
            isExpanded: true,
            decoration: InputDecoration(labelText: tr('Model (free, best first)')),
            items: [
              for (final m in models) DropdownMenuItem(value: '${m['id']}', child: Text('${m['label']}${m['vision'] == true ? ' · photos' : ''}${mark('${m['id']}')}', overflow: TextOverflow.ellipsis)),
              for (final id in _extra) DropdownMenuItem(value: id, child: Text('$id ✓', overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (v) => setState(() => _form['model'] = v),
          ),
          if (_liveError != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(_liveError!, style: TextStyle(color: cs.error, fontSize: 12.5))),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            OutlinedButton.icon(onPressed: _busy || _timing || (_key.text.isEmpty && p['ownAddress'] != true) ? null : _check, icon: const Icon(Icons.refresh, size: 18), label: const Tx('Check my key')),
            OutlinedButton.icon(onPressed: _busy || _timing || (_key.text.isEmpty && p['ownAddress'] != true) ? null : _speedTest, icon: const Icon(Icons.timer_outlined, size: 18), label: Text(_timing ? 'Timing each model…' : 'Test speed')),
          ]),
          if (_speed != null)
            Card(
              margin: const EdgeInsets.only(top: 8),
              child: Column(children: [
                for (final (i, r) in _speed!.indexed)
                  ListTile(
                    dense: true,
                    title: Text('${models.where((m) => m['id'] == r['model']).map((m) => '${m['label']}'.split(' — ').first).firstOrNull ?? r['model']}${i == 0 && r['ok'] == true ? ' · fastest, chosen' : ''}'),
                    trailing: Text(r['ok'] == true ? '${((r['firstMs'] ?? r['totalMs'] ?? 0) as num) / 1000}s' : '${r['error'] ?? 'failed'}', style: TextStyle(color: r['ok'] == true ? null : cs.error, fontSize: 12)),
                  ),
              ]),
            ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Tx('Extras (optional)'),
            children: [
              TextField(controller: _groq, obscureText: true, decoration: InputDecoration(labelText: tr('Groq key for voice notes'), helperText: tr('Turns Telegram voice notes into text (free).'))),
              const SizedBox(height: 10),
              TextField(controller: _brave, obscureText: true, decoration: InputDecoration(labelText: tr('Brave Search key for web research (free tier)'))),
              const SizedBox(height: 10),
              TextField(controller: _searx, keyboardType: TextInputType.url, decoration: InputDecoration(labelText: tr('…or a SearXNG address'), hintText: 'https://searx.example.org')),
              const SizedBox(height: 10),
            ],
          ),
        ],
        const SizedBox(height: 12),
        FilledButton(
          onPressed: _busy || (p['onDevice'] == true ? !_localReady : (_key.text.isEmpty && p['ownAddress'] != true)) ? null : _save,
          child: Text(_busy ? (p['onDevice'] == true ? 'Starting the model…' : 'Checking…') : 'Save and test'),
        ),
        if (_test != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(children: [Icon(_test!.$1 ? Icons.check_circle : Icons.error_outline, color: _test!.$1 ? Colors.green : cs.error, size: 18), const SizedBox(width: 6), Expanded(child: Text(_test!.$2))]),
          ),
        const SizedBox(height: 10),
        Text(p['onDevice'] == true ? 'Everything stays on this phone: the model runs here, with no internet.' : 'Your key stays on this phone and is sent only to ${p['label']}. Messages you send go to ${p['label']} to be answered; everything else stays on the phone.', style: t.bodySmall),
        if (!widget.compact) const SizedBox(height: 10),
        if (!widget.compact) ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.auto_awesome_outlined),
          title: const Tx('AI & connections'),
          subtitle: const Tx('Add more services or local AI, test models, choose one per job and set spending limits.'),
          onTap: () => openPath(context, '/connections'),
        ),
      ]);
    if (widget.compact) return list;
    return Scaffold(appBar: AppBar(title: const Tx('AI service')), body: list);
  }
}

/// The AI models that can run on this phone: download once, pick one, remove to free space.
class _LocalModels extends StatefulWidget {
  final String value;
  final ValueChanged<String> onChange;
  final ValueChanged<bool> onReady;
  const _LocalModels({required this.value, required this.onChange, required this.onReady});
  @override
  State<_LocalModels> createState() => _LocalModelsState();
}

class _LocalModelsState extends State<_LocalModels> {
  Map? _info;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load([Map<String, dynamic>? body]) async {
    final api = AppState.read(context).api;
    try {
      final r = body == null ? await api.get('/device/local') : await api.post('/device/local', body);
      if (!mounted) return;
      final info = r as Map;
      setState(() => _info = info);
      final downloading = (info['status'] as Map?)?['state'] == 'downloading';
      _poll?.cancel();
      if (downloading) _poll = Timer(const Duration(seconds: 1), _load);
      final models = (info['models'] as List).cast<Map>();
      final chosen = models.where((m) => m['id'] == widget.value).firstOrNull;
      widget.onReady(chosen?['downloaded'] == true);
      if (chosen?['downloaded'] != true) {
        final have = models.where((m) => m['downloaded'] == true).firstOrNull;
        if (have != null) widget.onChange('${have['id']}');
      }
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final info = _info;
    if (info == null) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
    final s = (info['status'] as Map?) ?? const {};
    final downloading = s['state'] == 'downloading';
    final free = ((info['storage'] as Map?)?['free']) as num?;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Tx('Model on this phone', style: Theme.of(context).textTheme.titleSmall),
      RadioGroup<String>(
        groupValue: widget.value,
        onChanged: (v) => v == null ? null : widget.onChange(v),
        child: Column(children: [
          for (final m in (info['models'] as List).cast<Map>())
            Card(
              margin: const EdgeInsets.only(top: 8),
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  RadioListTile<String>(
                    contentPadding: EdgeInsets.zero,
                    value: '${m['id']}',
                    enabled: m['downloaded'] == true,
                    title: Text('${m['label']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text('${_gb(m['size'] as num)} · ${m['note']}'),
                  ),
                  if (s['model'] == m['id'] && downloading) ...[
                    LinearProgressIndicator(value: (s['total'] as num? ?? 0) > 0 ? (s['loaded'] as num) / (s['total'] as num) : null),
                    Row(children: [Expanded(child: Tx('{0} of {1} · keep Carino open', args: [_gb(s['loaded'] as num? ?? 0), _gb(s['total'] as num? ?? m['size'] as num)], style: const TextStyle(fontSize: 12))), TextButton(onPressed: () => _load({'action': 'cancel'}), child: const Tx('Cancel'))]),
                  ] else if (m['downloaded'] == true)
                    Row(children: [const Icon(Icons.check_circle, color: Colors.green, size: 16), const Tx(' On this phone'), const Spacer(), TextButton.icon(onPressed: () => _load({'action': 'remove', 'model': m['id']}), icon: const Icon(Icons.delete_outline, size: 18), label: const Tx('Remove'))])
                  else
                    Row(children: [
                      FilledButton.tonalIcon(
                        onPressed: downloading || (free != null && free < (m['size'] as num) * 1.1) ? null : () => _load({'action': 'download', 'model': m['id']}),
                        icon: const Icon(Icons.download, size: 18),
                        label: Tx('Download {0}', args: [_gb(m['size'] as num)]),
                      ),
                      if (free != null && free < (m['size'] as num) * 1.1) const Tx('  Not enough free space', style: TextStyle(fontSize: 12, color: Colors.orange)),
                    ]),
                  if (s['state'] == 'error' && s['model'] == m['id']) Text('${s['error']}', style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
                ]),
              ),
            ),
        ]),
      ),
      Padding(padding: const EdgeInsets.only(top: 6), child: Tx('Use Wi-Fi for the download. After that it works with no internet.{0}', args: [(info['threads'] as num? ?? 1) > 1 ? ' Uses ${info['threads']} processor cores.' : ''], style: Theme.of(context).textTheme.bodySmall)),
    ]);
  }
}
