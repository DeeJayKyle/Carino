import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../engine/engine.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

const _status = {'ok': 'Connected', 'offline': 'Not reachable', 'needs_sign_in': 'Needs you to sign in again', 'error': 'Problem', 'unchecked': 'Not checked yet'};
const _roles = [
  ('everyday', 'Everyday chat', 'Quick questions, to-dos, reminders'),
  ('complex', 'Complex tasks', 'Reports, plans, analysis, long chats'),
  ('vision', 'Photos', 'Receipts, documents and pictures you attach'),
  ('offline', 'Offline', 'When there’s no internet'),
];

/// Everything Carino is connected to, and how it picks AI models: services and local AI it found,
/// each model's tested abilities, speed and cost, the choice per job, spending limits and accounts.
class ConnectionsScreen extends StatefulWidget {
  const ConnectionsScreen({super.key});
  @override
  State<ConnectionsScreen> createState() => _ConnectionsScreenState();
}

class _ConnectionsScreenState extends State<ConnectionsScreen> {
  Map? _models;
  Map? _conns;
  Map? _usage;
  List<Map>? _found;
  bool _noDiscover = false;
  List<Map> _added = const [];
  bool _onDevice = false;
  Object? _error;
  bool _checking = false;
  bool _looking = false;
  String _busy = '';
  bool _adding = false;
  bool _showAll = false;
  String? _pricing;
  final _pIn = TextEditingController();
  final _pOut = TextEditingController();
  final _daily = TextEditingController();
  final _monthly = TextEditingController();

  Api get _api => AppState.read(context).api;
  Map get _ai => (AppState.read(context).settings['ai'] as Map?) ?? const {};
  List<String> _list(String k) => ((_ai[k] as List?) ?? const []).map((e) => '$e').toList();

  @override
  void initState() {
    super.initState();
    final spend = (_ai['spend'] as Map?) ?? const {};
    _daily.text = spend['dailyUsd'] == null ? '' : '${spend['dailyUsd']}';
    _monthly.text = spend['monthlyUsd'] == null ? '' : '${spend['monthlyUsd']}';
    _load();
    _look();
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([_api.get('/models'), _api.get('/connections')]);
      final usage = await _api.get('/usage/summary').catchError((_) => null);
      final dev = await _api.get('/device/connections').then((v) => v as Map?).catchError((_) => null);
      if (!mounted) return;
      setState(() {
        _models = r[0] as Map;
        _conns = r[1] as Map;
        _usage = usage as Map?;
        _onDevice = dev != null;
        _added = ((dev?['connections'] as List?) ?? const []).cast<Map>();
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _look() async {
    setState(() => _looking = true);
    try {
      final r = await _api.get('/device/discover') as Map;
      if (mounted) setState(() => _found = ((r['found'] as List?) ?? const []).cast<Map>());
    } catch (e) {
      if (e is ApiError && e.status == 404) {
        if (mounted) setState(() => _noDiscover = true);
      } else if (mounted) {
        toast(context, errorText(e), error: true);
      }
    } finally {
      if (mounted) setState(() => _looking = false);
    }
  }

  Future<void> _saveAi(Map<String, dynamic> p) async {
    final app = AppState.read(context);
    try {
      await app.api.patch('/settings', {'ai': p});
      await app.loadMe();
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  Future<void> _checkAll() async {
    setState(() => _checking = true);
    try {
      final r = await _api.post('/connections/refresh', {}) as Map;
      final n = (((r['result'] as Map?)?['problems'] as List?) ?? const []).length;
      if (mounted) toast(context, n > 0 ? 'Checked. $n need${n == 1 ? 's' : ''} attention.' : 'Everything is connected');
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _check(String id) async {
    setState(() => _busy = id);
    try {
      final r = ((await _api.post('/models/refresh', {'conn_id': id}) as Map)['results'] as List).first as Map;
      if (mounted) toast(context, r['ok'] == true ? '${r['models']} models available' : '${r['error']}', error: r['ok'] != true);
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = '');
    }
  }

  Future<void> _test(Map m, {bool confirmCost = false}) async {
    setState(() => _busy = '${m['ref']}');
    try {
      final r = (await _api.post('/models/test', {'ref': m['ref'], 'confirm_cost': confirmCost}) as Map)['result'] as Map;
      if (mounted) toast(context, r['ok'] == true ? '${m['model']}: tested' : '${m['model']}: ${r['error']}', error: r['ok'] != true);
      await _load();
    } catch (e) {
      final data = e is ApiError ? e.data : null;
      if (e is ApiError && e.status == 409 && data is Map && data['needs_confirmation'] == true) {
        if (mounted) setState(() => _busy = '');
        final est = data['estimate_usd'] as num?;
        if (!mounted) return;
        final ok = await confirmDialog(context, title: 'Test ${m['model']}?', body: 'This model costs money. A test uses about ${est != null ? '\$${est.toStringAsFixed(4)}' : 'a few thousand tokens (price unknown)'} of your ${m['connection']} credit.', confirm: 'Test it');
        if (ok) return _test(m, confirmCost: true);
        return;
      }
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = '');
    }
  }

  Future<void> _savePrice() async {
    final i = double.tryParse(_pIn.text.trim());
    final o = double.tryParse(_pOut.text.trim());
    if (i == null || o == null || i < 0 || o < 0) return toast(context, 'Enter two prices, like 0.25 and 2', error: true);
    try {
      await _api.post('/models/price', {'ref': _pricing, 'input': i, 'output': o});
      setState(() => _pricing = null);
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppState.of(context); // rebuild when settings change
    final m = _models, c = _conns;
    return Scaffold(
      appBar: AppBar(title: const Text('AI & connections'), actions: [
        TextButton.icon(onPressed: _checking ? null : _checkAll, icon: const Icon(Icons.refresh, size: 18), label: Text(_checking ? 'Checking…' : 'Check all')),
      ]),
      body: m == null || c == null
          ? (_error != null ? ErrorPanel(error: _error!, retry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
                Text('The AI services, local AI and accounts Carino may use. Carino only uses what you set up here, keeps sign-ins fresh by itself, and never sends private content to an online AI.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
                _services(m),
                if (!_noDiscover) _foundHere(),
                _choices(m),
                _modelList(m),
                _spending(),
                _accounts(c),
              ]),
            ),
    );
  }

  Widget _section(String title, String? sub, List<Widget> children, {Widget? action}) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.only(top: 14),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)), ?action]),
          if (sub != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(sub, style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant))),
          const SizedBox(height: 8),
          ...children,
        ]),
      ),
    );
  }

  Widget _chip(String status) {
    final cs = Theme.of(context).colorScheme;
    return Pill(_status[status] ?? status, color: status == 'ok' ? Colors.green : status == 'offline' ? Colors.orange : status == 'unchecked' ? cs.outline : cs.error);
  }

  Widget _services(Map data) {
    final cs = Theme.of(context).colorScheme;
    final approved = _list('approvedPaid');
    final extras = _added.map((x) => x['id']).toSet();
    final conns = ((data['connections'] as List?) ?? const []).cast<Map>();
    return _section('AI services', 'Where Carino’s answers come from. Your main service is set in Settings → AI service; add more here so Carino can pick the best one for each message.', [
      if (conns.isEmpty) ListTile(contentPadding: EdgeInsets.zero, title: const Text('No AI service yet'), trailing: TextButton(onPressed: () => openPath(context, '/settings#ai'), child: const Text('Set one up'))),
      for (final s in conns)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(child: Text('${s['label']}', style: const TextStyle(fontWeight: FontWeight.w700))),
              if (s['main'] == true) const Padding(padding: EdgeInsets.only(left: 6), child: Pill('Main')),
              const SizedBox(width: 6),
              _chip('${s['status']}'),
            ]),
            Text('${s['local'] == true ? 'On your devices — content stays with you' : 'Online'} · ${s['billing'] == 'free' ? 'Free' : s['billing'] == 'paid' ? 'Paid' : 'May cost money'} · ${s['models']} model${s['models'] == 1 ? '' : 's'}${s['api'] == 'responses' ? ' · Responses API' : ''}', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
            if (s['detail'] != null && s['status'] != 'ok') Text('${s['detail']}', style: const TextStyle(fontSize: 12, color: Colors.orange)),
            Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 4, children: [
              if (s['billing'] != 'free' && s['main'] != true)
                Row(mainAxisSize: MainAxisSize.min, children: [
                  const Text('Allow paid use', style: TextStyle(fontSize: 13)),
                  Switch(
                    value: approved.contains(s['id']),
                    onChanged: (on) async {
                      if (on && !await confirmDialog(context, title: 'Allow paid use of ${s['label']}?', body: 'Carino may then pick ${s['label']}’s models when they suit a message best, and each use costs money on your ${s['label']} account. You can set a spending limit below; at the limit, Carino stops using paid models.', confirm: 'Allow')) return;
                      await _saveAi({'approvedPaid': on ? {...approved, '${s['id']}'}.toList() : approved.where((x) => x != s['id']).toList()});
                    },
                  ),
                ]),
              TextButton.icon(onPressed: _busy == s['id'] ? null : () => _check('${s['id']}'), icon: const Icon(Icons.refresh, size: 16), label: Text(_busy == s['id'] ? 'Checking…' : 'Check')),
              if (extras.contains(s['id']))
                TextButton.icon(
                  onPressed: () async {
                    if (!await confirmDialog(context, title: 'Remove ${s['label']}?', body: 'Carino stops using it and deletes its saved key from this device.', confirm: 'Remove')) return;
                    try {
                      await _api.delete('/device/connections/${s['id']}');
                      if (mounted) toast(context, 'Removed ${s['label']}');
                      await _load();
                    } catch (e) {
                      if (mounted) toast(context, errorText(e), error: true);
                    }
                  },
                  icon: const Icon(Icons.close, size: 16),
                  label: const Text('Remove'),
                ),
            ]),
          ]),
        ),
      if (_adding) _AddService(onDone: (added) async { setState(() => _adding = false); if (added) await _load(); }),
    ], action: _onDevice && !_adding ? FilledButton.tonalIcon(onPressed: () => setState(() => _adding = true), icon: const Icon(Icons.add, size: 16), label: const Text('Add a service')) : null);
  }

  Widget _foundHere() {
    final found = _found;
    bool isAdded(Map f) => _added.any((x) => f['kind'] == 'phone' ? x['preset'] == 'phone' : x['baseUrl'] == f['baseUrl']);
    return _section('AI on your devices', 'Carino looks only on this device and the PC you paired with, for Ollama, LM Studio and similar servers — never across your network. Nothing is added until you choose.', [
      if (found == null)
        const LinearProgressIndicator()
      else if (found.isEmpty)
        const Text('None found. If you use Ollama or LM Studio, start it and look again.', style: TextStyle(fontSize: 13))
      else
        for (final f in found)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.lock_outline),
            title: Text('${f['label']} on ${f['where']}'),
            subtitle: Text([
              () {
                final ms = ((f['models'] as List?) ?? const []).cast<Map>();
                return '${ms.length} model${ms.length == 1 ? '' : 's'}${ms.isNotEmpty ? ': ${ms.take(4).map((x) => x['id']).join(', ')}${ms.length > 4 ? '…' : ''}' : ''}';
              }(),
              if (f['blocked'] != null) '${f['blocked']}',
            ].join('\n')),
            trailing: isAdded(f)
                ? const Pill('Added', color: Colors.green)
                : OutlinedButton(
                    onPressed: () async {
                      try {
                        final r = await _api.post('/device/connections', f['kind'] == 'phone' ? {'preset': 'phone'} : {'preset': 'custom', 'baseUrl': f['baseUrl'], 'label': '${f['label']} (${f['where']})'}) as Map;
                        final check = r['check'] as Map?;
                        if (mounted) toast(context, check?['ok'] == true ? 'Added ${f['label']} — ${check!['models']} models' : 'Added ${f['label']}');
                        await _load();
                      } catch (e) {
                        if (mounted) toast(context, errorText(e), error: true);
                      }
                    },
                    child: const Text('Add'),
                  ),
          ),
    ], action: TextButton.icon(onPressed: _looking ? null : _look, icon: const Icon(Icons.search, size: 16), label: Text(_looking ? 'Looking…' : 'Look again')));
  }

  Widget _choices(Map data) {
    final usable = ((data['models'] as List?) ?? const []).cast<Map>().where((x) => x['blocked'] == null).toList();
    final roles = Map<String, dynamic>.from((_ai['roles'] as Map?) ?? const {});
    final recs = (data['recommendations'] as Map?) ?? const {};
    return _section('How Carino picks a model', 'For each message Carino picks among the models you allow, by what the message needs, privacy, speed and your budget. Private chats and local-only content only ever go to models on your devices.', [
      SwitchListTile(contentPadding: EdgeInsets.zero, value: _ai['autoSelect'] != false, onChanged: (v) => _saveAi({'autoSelect': v}), title: const Text('Pick the model for each message automatically')),
      Row(children: [
        const Expanded(child: Text('Prefer')),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'privacy', label: Text('Privacy')), ButtonSegment(value: 'balanced', label: Text('Balanced')), ButtonSegment(value: 'speed', label: Text('Speed'))],
          selected: {'${_ai['prefer'] ?? 'balanced'}'},
          showSelectedIcon: false,
          onSelectionChanged: (v) => _saveAi({'prefer': v.first}),
        ),
      ]),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: _ai['localOnly'] == true, onChanged: (v) => _saveAi({'localOnly': v}), title: const Text('Keep everything on my devices (local models only)')),
      for (final (role, label, hint) in _roles)
        () {
          final rec = recs[role] as Map?;
          final list = usable.where((x) => (role != 'vision' || (x['caps'] as Map?)?['vision'] != false) && (role != 'offline' || x['local'] == true)).toList();
          final current = roles[role] as String?;
          final value = list.any((x) => x['ref'] == current) ? current : null;
          return Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              DropdownButtonFormField<String?>(
                isExpanded: true,
                initialValue: value,
                decoration: InputDecoration(labelText: '$label — $hint'),
                items: [
                  DropdownMenuItem(value: null, child: Text('Automatic${rec != null ? ' (now: ${rec['label']})' : ''}')),
                  for (final x in list) DropdownMenuItem(value: '${x['ref']}', child: Text('${x['label'] ?? x['model']} · ${x['connection']}${x['paid'] == false ? ' · free' : ''}${x['local'] == true ? ' · on device' : ''}', overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => _saveAi({'roles': {...roles, role: v}..removeWhere((_, x) => x == null)}),
              ),
              Text(
                rec != null ? 'Recommended: ${rec['label']} (${rec['why']})' : role == 'offline' ? 'No model on this device yet — add Ollama or the on-phone model to keep working offline.' : role == 'vision' ? 'No tested model reads photos yet — test one below.' : 'Test your models below to get a recommendation.',
                style: const TextStyle(fontSize: 12),
              ),
            ]),
          );
        }(),
    ]);
  }

  Widget _modelList(Map data) {
    final cs = Theme.of(context).colorScheme;
    final disabled = _list('disabledModels');
    final all = ((data['models'] as List?) ?? const []).cast<Map>().where((x) => _showAll || x['status'] != 'unavailable').toList();
    final shown = _showAll ? all : all.take(30).toList();
    return _section('Models', 'Tested for real: a reply, using tools, pulling out details, a small reasoning step and reading a photo. Free and local models can be tested any time; paid ones show the cost first.', [
      if (all.isEmpty) const Text('No models yet.'),
      for (final x in shown)
        () {
          final off = disabled.contains(x['ref']);
          final caps = (x['caps'] as Map?) ?? const {};
          return Opacity(
            opacity: off ? 0.6 : 1,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text('${x['label'] ?? x['model']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700))),
                  if (x['main'] == true) const Pill('Main'),
                  Switch(value: !off, onChanged: (v) => _saveAi({'disabledModels': v ? disabled.where((r) => r != x['ref']).toList() : [...disabled, '${x['ref']}']})),
                ]),
                Text('${x['connection']}', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                const SizedBox(height: 4),
                Wrap(spacing: 4, runSpacing: 4, children: [
                  if (x['local'] == true) const Pill('On device', color: Colors.green),
                  if (x['paid'] == false) const Pill('Free', color: Colors.green) else if (x['price_in'] != null) Pill('\$${x['price_in']}/\$${x['price_out']} per M') else Pill('${x['paid'] == true ? 'Paid' : 'May cost'} · price unknown', color: Colors.orange),
                  if (caps['vision'] == true) const Pill('Photos'),
                  if (caps['tools'] == true) const Pill('Tools'),
                  if (caps['tools'] == false) const Pill('No tools', color: Colors.orange),
                  if (caps['api'] == 'responses') const Pill('Responses API'),
                  if (x['quality'] != null) Pill('${((x['quality'] as num) * 100).round()}%'),
                  if (x['latency_ms'] != null) Pill('${((x['latency_ms'] as num) / 1000).toStringAsFixed(1)}s'),
                  if (x['status'] == 'unavailable') Pill('Unavailable', color: cs.error),
                  if (x['status'] == 'limited') const Pill('Rate-limited', color: Colors.orange),
                ]),
                if (x['blocked'] != null && !off) Text('Not used: ${x['blocked']}', style: const TextStyle(fontSize: 12)),
                if (x['last_error'] != null && x['status'] != 'ok') Text(x['last_error'] == 'gone' ? 'No longer offered by the service.' : '${x['last_error']}', style: const TextStyle(fontSize: 12, color: Colors.orange)),
                Wrap(spacing: 4, children: [
                  TextButton(onPressed: _busy.isNotEmpty ? null : () => _test(x), child: Text(_busy == x['ref'] ? 'Testing…' : x['tested_at'] != null ? 'Test again' : 'Test')),
                  if (x['paid'] != false)
                    TextButton(
                      onPressed: () => setState(() {
                        _pricing = '${x['ref']}';
                        _pIn.text = x['price_in'] == null ? '' : '${x['price_in']}';
                        _pOut.text = x['price_out'] == null ? '' : '${x['price_out']}';
                      }),
                      child: const Text('Price'),
                    ),
                ]),
                if (_pricing == x['ref'])
                  Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Expanded(child: TextField(controller: _pIn, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Input, USD per M tokens'))),
                    const SizedBox(width: 8),
                    Expanded(child: TextField(controller: _pOut, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Output'))),
                    IconButton(tooltip: 'Save price', onPressed: _savePrice, icon: const Icon(Icons.check)),
                    IconButton(tooltip: 'Cancel', onPressed: () => setState(() => _pricing = null), icon: const Icon(Icons.close)),
                  ]),
              ]),
            ),
          );
        }(),
      if (all.length > 30 && !_showAll) TextButton(onPressed: () => setState(() => _showAll = true), child: Text('Show all ${all.length} models')),
    ]);
  }

  Widget _spending() {
    final d = _usage;
    String usd(num? v) => '\$${(v ?? 0).toStringAsFixed((v ?? 0) < 1 ? 4 : 2)}';
    Widget bar(num spent, num? cap) {
      if (cap == null || cap == 0) return const SizedBox.shrink();
      final f = (spent / cap).clamp(0, 1).toDouble();
      return Padding(padding: const EdgeInsets.only(top: 4), child: LinearProgressIndicator(value: f, color: spent >= cap ? Colors.red : spent >= cap * 0.8 ? Colors.orange : null));
    }

    final limits = (d?['limits'] as Map?) ?? const {};
    final warning = (d?['warning'] as Map?) ?? const {};
    final byModel = ((d?['byModel'] as List?) ?? const []).cast<Map>();
    return _section('Spending', 'What AI has cost, from what each service charges. At a limit, Carino stops using paid models; free and local ones carry on. You’re warned at 80%.', [
      if (d == null)
        const LinearProgressIndicator()
      else ...[
        Row(children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Last 24 hours', style: TextStyle(fontSize: 12)),
            Text('${usd(d['today'] as num?)}${limits['dailyUsd'] != null ? ' of \$${limits['dailyUsd']}' : ''}', style: Theme.of(context).textTheme.titleLarge),
            bar((d['today'] as num?) ?? 0, limits['dailyUsd'] as num?),
          ])),
          const SizedBox(width: 16),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Last 30 days', style: TextStyle(fontSize: 12)),
            Text('${usd(d['month'] as num?)}${limits['monthlyUsd'] != null ? ' of \$${limits['monthlyUsd']}' : ''}', style: Theme.of(context).textTheme.titleLarge),
            bar((d['month'] as num?) ?? 0, limits['monthlyUsd'] as num?),
          ])),
        ]),
        if (warning['today'] != null || warning['month'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(warning['today'] == 'reached' || warning['month'] == 'reached' ? 'A spending limit is reached: paid models are paused.' : 'You’ve used over 80% of a spending limit.', style: const TextStyle(color: Colors.orange)),
          ),
        Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Expanded(child: TextField(controller: _daily, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Daily limit (USD)', hintText: 'No limit'))),
          const SizedBox(width: 8),
          Expanded(child: TextField(controller: _monthly, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Monthly limit (USD)', hintText: 'No limit'))),
          const SizedBox(width: 8),
          OutlinedButton(
            onPressed: () {
              num? n(String v) => v.trim().isEmpty ? null : ((num.tryParse(v.trim()) ?? 0) < 0 ? 0 : num.tryParse(v.trim()));
              _saveAi({'spend': {'dailyUsd': n(_daily.text), 'monthlyUsd': n(_monthly.text)}});
            },
            child: const Text('Save limits'),
          ),
        ]),
        if (byModel.isNotEmpty) ...[
          const SizedBox(height: 10),
          Table(
            columnWidths: const {0: FlexColumnWidth(3), 1: FlexColumnWidth(1), 2: FlexColumnWidth(2), 3: FlexColumnWidth(1.5)},
            children: [
              const TableRow(children: [Text('Model', style: TextStyle(fontWeight: FontWeight.w700)), Text('Uses', style: TextStyle(fontWeight: FontWeight.w700)), Text('Tokens', style: TextStyle(fontWeight: FontWeight.w700)), Text('Cost', style: TextStyle(fontWeight: FontWeight.w700))]),
              for (final r in byModel)
                TableRow(children: [
                  Text('${r['model']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                  Text('${r['calls']}'),
                  Text('${((r['input_tokens'] as num? ?? 0) + (r['output_tokens'] as num? ?? 0)).toInt()}'),
                  Text(usd(r['cost_usd'] as num?)),
                ]),
            ],
          ),
        ],
      ],
    ]);
  }

  Widget _accounts(Map data) {
    final accounts = ((data['accounts'] as List?) ?? const []).cast<Map>();
    final connectors = ((data['connectors'] as List?) ?? const []).cast<Map>();
    return _section('Accounts and connected tools', 'Signed in once; Carino refreshes these by itself. If one needs you, it shows here.', [
      if (accounts.isEmpty && connectors.isEmpty) ListTile(contentPadding: EdgeInsets.zero, title: const Text('None yet.'), trailing: TextButton(onPressed: () => openPath(context, '/apps'), child: const Text('Connect an app'))),
      for (final a in accounts)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${a['provider_label']} · ${a['label']}'),
          subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Align(alignment: Alignment.centerLeft, child: _chip('${a['status']}')),
            if (a['detail'] != null && a['status'] != 'ok') Text('${a['detail']}', style: const TextStyle(fontSize: 12, color: Colors.orange)),
          ]),
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            if (a['status'] == 'needs_sign_in') TextButton(onPressed: () => openPath(context, '/apps'), child: const Text('Sign in')),
            TextButton(
              onPressed: () async {
                if (!await confirmDialog(context, title: 'Disconnect ${a['provider_label']} (${a['label']})?', body: 'Carino signs out, asks the provider to cancel its access where it can, and deletes the saved sign-in.', confirm: 'Disconnect')) return;
                try {
                  final r = await _api.delete('/apps/accounts/${a['id']}') as Map?;
                  if (mounted) toast(context, r?['revoked'] == true ? 'Disconnected — ${a['provider_label']} cancelled Carino’s access' : 'Disconnected. To remove Carino’s access at ${a['provider_label']} too, open its connected-apps page.');
                  if (r?['revoked'] != true && r?['manage_url'] != null) await Device(_api).openExternal('${r!['manage_url']}');
                  await _load();
                } catch (e) {
                  if (mounted) toast(context, errorText(e), error: true);
                }
              },
              child: const Text('Disconnect'),
            ),
          ]),
        ),
      for (final k in connectors)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${k['name']}'),
          subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(k['enabled'] == true ? 'Connected tool' : 'Switched off', style: const TextStyle(fontSize: 12)),
            Align(alignment: Alignment.centerLeft, child: _chip('${k['status']}')),
            if (k['detail'] != null && k['status'] != 'ok') Text('${k['detail']}', style: const TextStyle(fontSize: 12, color: Colors.orange)),
          ]),
          trailing: TextButton(onPressed: () => openPath(context, '/connectors'), child: const Text('Manage')),
        ),
    ]);
  }
}

class _AddService extends StatefulWidget {
  final void Function(bool added) onDone;
  const _AddService({required this.onDone});
  @override
  State<_AddService> createState() => _AddServiceState();
}

class _AddServiceState extends State<_AddService> {
  List<Map>? _presets;
  String _preset = '';
  final _key = TextEditingController();
  final _url = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    AppState.read(context).api.get('/device/config').then((r) {
      final list = (((r as Map)['presets'] as List?) ?? const []).cast<Map>().where((p) => p['hidden'] != true).toList();
      if (mounted) setState(() { _presets = list; _preset = list.isEmpty ? '' : '${list.first['id']}'; });
    }).catchError((_) { if (mounted) setState(() => _presets = []); });
  }

  Map? get _p => _presets?.where((x) => x['id'] == _preset).firstOrNull;

  Future<void> _add() async {
    final p = _p;
    setState(() => _saving = true);
    try {
      final r = await AppState.read(context).api.post('/device/connections', {'preset': _preset, if (_key.text.trim().isNotEmpty) 'apiKey': _key.text.trim(), if (p?['ownAddress'] == true) 'baseUrl': _url.text.trim()}) as Map;
      final check = r['check'] as Map?;
      if (mounted) toast(context, check?['ok'] == true ? 'Added — ${check!['models']} models found' : 'Added. ${check?['error'] ?? ''}');
      widget.onDone(true);
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final presets = _presets;
    if (presets == null) return const LinearProgressIndicator();
    final p = _p;
    final needsKey = p?['keyUrl'] != null && p?['ownAddress'] != true;
    final own = p?['ownAddress'] == true;
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          DropdownButtonFormField<String>(
            isExpanded: true,
            initialValue: _preset.isEmpty ? null : _preset,
            decoration: const InputDecoration(labelText: 'Service'),
            items: [for (final x in presets) DropdownMenuItem(value: '${x['id']}', child: Text('${x['label']}${x['paid'] == true ? ' (paid)' : x['onDevice'] == true || x['ownAddress'] == true ? ' (on your devices)' : ' (free)'}'))],
            onChanged: (v) => setState(() => _preset = v ?? ''),
          ),
          if (p?['free'] != null) Text('${p!['free']}', style: const TextStyle(fontSize: 12)),
          if (own) TextField(controller: _url, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Address', hintText: 'http://localhost:11434/v1')),
          if (needsKey) TextField(controller: _key, obscureText: true, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: 'Key', helperText: 'Get one at ${'${p!['keyUrl']}'.replaceFirst('https://', '')}. It’s checked, then stored encrypted on this device.', helperMaxLines: 3)),
          if (p?['paid'] == true) const Padding(padding: EdgeInsets.only(top: 8), child: Text('Paid service: Carino won’t use it until you allow paid use, and you can set a spending limit.', style: TextStyle(fontSize: 12))),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: () => widget.onDone(false), child: const Text('Cancel')),
            FilledButton(onPressed: _saving || _preset.isEmpty || (needsKey && _key.text.trim().isEmpty) || (own && _url.text.trim().isEmpty) ? null : _add, child: Text(_saving ? 'Checking…' : 'Add')),
          ]),
        ]),
      ),
    );
  }
}
