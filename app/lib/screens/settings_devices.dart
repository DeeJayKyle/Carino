import 'dart:async';
import '../l10n.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

const _tables = {'tasks': 'To-do', 'memories': 'Memory', 'expenses': 'Spending', 'notes': 'Note', 'reminders': 'Reminder', 'applications': 'Application', 'income': 'Income', 'bills': 'Bill', 'debts': 'Debt', 'savings_goals': 'Savings goal', 'conversations': 'Chat'};

/// Pair the phone and the PC, compare the check number, sync, and settle what changed on both.
class DevicesSettings extends StatefulWidget {
  const DevicesSettings({super.key});
  @override
  State<DevicesSettings> createState() => _DevicesSettingsState();
}

class _DevicesSettingsState extends State<DevicesSettings> {
  Map? _data;
  Timer? _poll;
  bool _busy = false;

  bool get _isPc => defaultTargetPlatform == TargetPlatform.windows;

  @override
  void initState() {
    super.initState();
    _load();
    // Syncs also run in the background; keep this screen current.
    _poll = Timer.periodic(const Duration(seconds: 4), (_) => _load());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await AppState.read(context).api.get('/sync') as Map;
      if (mounted) setState(() => _data = d);
    } catch (_) {}
  }

  Future<T?> _run<T>(Future<T> Function() fn, [String? ok]) async {
    setState(() => _busy = true);
    try {
      final r = await fn();
      if (mounted && ok != null) toast(context, ok);
      await _load();
      return r;
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
      return null;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check(String id, String name, [String? check]) async {
    final api = AppState.read(context).api;
    final number = check ?? '${((await api.get('/sync/peers/$id/check')) as Map)['check']}';
    if (!mounted) return;
    final match = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Tx('Compare the check number'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Tx('Does {0} show the same number?', args: [name]),
          const SizedBox(height: 12),
          Text(number, style: Theme.of(ctx).textTheme.displaySmall?.copyWith(fontWeight: FontWeight.w800, letterSpacing: 4)),
          const SizedBox(height: 8),
          const Tx('If they match, nobody else is in the middle. If not, don’t pair.', textAlign: TextAlign.center),
        ]),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Tx('They don’t match')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Tx('They match'))],
      ),
    );
    if (match == true) {
      await _run(() => api.post('/sync/peers/$id/confirm', {}), 'Paired');
    } else if (match == false) {
      await _run(() => api.delete('/sync/peers/$id'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final api = AppState.read(context).api;
    return Scaffold(
      appBar: AppBar(title: const Tx('Devices')),
      body: d == null
          ? const Center(child: CircularProgressIndicator())
          : ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
              Tx('Your phone and your PC, kept in step over your Wi-Fi. Nothing goes through the internet.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
              const SizedBox(height: 10),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(_isPc ? Icons.computer : Icons.phone_iphone),
                title: Tx('This device: {0}', args: [(d['device'] as Map?)?['name'] ?? '']),
                trailing: TextButton(
                  onPressed: () async {
                    final c = TextEditingController(text: '${(d['device'] as Map?)?['name'] ?? ''}');
                    final n = await showDialog<String>(context: context, builder: (ctx) => AlertDialog(title: const Tx('Name this device'), content: TextField(controller: c, autofocus: true), actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Tx('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Tx('Save'))]));
                    if (n != null && n.trim().isNotEmpty) await _run(() => api.patch('/sync/device', {'name': n.trim()}));
                  },
                  child: const Tx('Rename'),
                ),
              ),
              for (final p in (d['peers'] as List).cast<Map>())
                Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: Icon(p['role'] == 'listener' ? Icons.computer : Icons.phone_iphone),
                    title: Text('${p['name']}'),
                    subtitle: Text(p['confirmed'] != true
                        ? 'Waiting for you to compare the check number'
                        : p['last_error'] != null
                            ? '${p['last_error']}'
                            : p['last_sync_at'] != null
                                ? 'Synced ${fmtDateTime(p['last_sync_at'] as String?)}${(p['pending'] as num? ?? 0) > 0 ? ' · ${p['pending']} to send' : ''}'
                                : 'Not synced yet'),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (p['confirmed'] != true) FilledButton.tonal(onPressed: () => _check('${p['device_id']}', '${p['name']}'), child: const Tx('Check number')),
                      IconButton(
                        tooltip: tr('Forget {0}', [p['name']]),
                        icon: const Icon(Icons.close),
                        onPressed: () async {
                          if (await confirmDialog(context, title: tr('Forget {0}?', [p['name']]), body: tr('They stop syncing. Nothing already on either device is deleted.'), confirm: tr('Forget'), danger: true)) {
                            await _run(() => api.delete('/sync/peers/${p['device_id']}'), 'Forgotten');
                          }
                        },
                      ),
                    ]),
                  ),
                ),
              const SizedBox(height: 6),
              Wrap(spacing: 8, runSpacing: 8, children: [
                if (!_isPc && (d['peers'] as List).isNotEmpty)
                  OutlinedButton.icon(
                    onPressed: _busy
                        ? null
                        : () => _run(() async {
                              final r = await api.post('/sync/now', {}) as Map;
                              final n = ((r['results'] as List?) ?? const []).fold<num>(0, (a, x) => a + ((x as Map)['sent'] as num? ?? 0) + (x['received'] as num? ?? 0));
                              if (context.mounted) toast(context, n > 0 ? 'Synced $n change${n == 1 ? '' : 's'}${(r['conflicts'] ?? 0) > 0 ? ' · ${r['conflicts']} to check' : ''}' : 'Up to date');
                            }),
                    icon: const Icon(Icons.sync),
                    label: const Tx('Sync now'),
                  ),
                FilledButton.icon(
                  onPressed: () async {
                    if (_isPc) {
                      await showDialog<void>(context: context, builder: (_) => const _ShowPairing());
                      await _load();
                    } else {
                      final r = await Navigator.of(context).push<Map>(MaterialPageRoute(builder: (_) => const _JoinPairing()));
                      if (r != null && mounted) await _check('${r['peer']}', '${r['name']}', '${r['check']}');
                    }
                  },
                  icon: const Icon(Icons.add_link),
                  label: Text(_isPc ? 'Pair a phone' : 'Pair with my PC'),
                ),
              ]),
              const SizedBox(height: 18),
              _Conflicts(conflicts: (d['conflicts'] as List? ?? const []).cast<Map>(), onDone: _load),
            ]),
    );
  }
}

/// On the phone: scan the PC's QR code, or type its code and address.
class _JoinPairing extends StatefulWidget {
  const _JoinPairing();
  @override
  State<_JoinPairing> createState() => _JoinPairingState();
}

class _JoinPairingState extends State<_JoinPairing> {
  final _link = TextEditingController();
  final _code = TextEditingController();
  final _address = TextEditingController();
  bool _scanning = true;
  bool _busy = false;

  Future<void> _join(Map<String, dynamic> body) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = await AppState.read(context).api.post('/sync/pair/join', body) as Map;
      if (mounted) Navigator.pop(context, r);
    } catch (e) {
      if (mounted) {
        toast(context, errorText(e), error: true);
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Tx('Pair with my PC')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Tx('On your PC, open Carino → Settings → Devices → Pair a phone. Then scan the code it shows.'),
        const SizedBox(height: 12),
        if (_scanning)
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: SizedBox(
              height: 280,
              child: MobileScanner(
                onDetect: (capture) {
                  final v = capture.barcodes.map((b) => b.rawValue).whereType<String>().where((s) => s.startsWith('carino-pair:')).firstOrNull;
                  if (v != null) {
                    setState(() => _scanning = false);
                    _join({'link': v});
                  }
                },
                errorBuilder: (context, error) => Center(child: Padding(padding: const EdgeInsets.all(16), child: Tx('The camera isn’t available. Type the code instead.', textAlign: TextAlign.center))),
              ),
            ),
          ),
        TextButton(onPressed: () => setState(() => _scanning = !_scanning), child: Text(_scanning ? 'Type the code instead' : 'Scan the QR code')),
        if (!_scanning) ...[
          TextField(controller: _link, decoration: InputDecoration(labelText: tr('Pairing link (from the QR code)'), hintText: tr('carino-pair:…'))),
          const SizedBox(height: 10),
          const Tx('…or'),
          const SizedBox(height: 10),
          TextField(controller: _code, textCapitalization: TextCapitalization.characters, decoration: InputDecoration(labelText: tr('Code'), hintText: tr('ABCDE-FGHJK'))),
          const SizedBox(height: 10),
          TextField(controller: _address, keyboardType: TextInputType.url, decoration: InputDecoration(labelText: tr('PC address'), hintText: '192.168.1.20:47123')),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy ? null : () => _join(_link.text.trim().isNotEmpty ? {'link': _link.text.trim(), if (_address.text.trim().isNotEmpty) 'address': _address.text.trim()} : {'code': _code.text.trim(), 'address': _address.text.trim()}),
            child: Text(_busy ? 'Pairing…' : 'Pair'),
          ),
        ],
        if (_busy) const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())),
      ]),
    );
  }
}

/// On the PC: a code and QR code for the phone, valid for 10 minutes.
class _ShowPairing extends StatefulWidget {
  const _ShowPairing();
  @override
  State<_ShowPairing> createState() => _ShowPairingState();
}

class _ShowPairingState extends State<_ShowPairing> {
  Map? _p;
  int? _peers;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    final app = AppState.read(context);
    try {
      final addresses = await app.api.post('/device/native', {'action': 'lanAddresses'}).then((r) => ((r as Map)['addresses'] as List?)?.cast<String>() ?? const <String>[]).catchError((_) => const <String>[]);
      final p = await app.api.post('/sync/pair/start', {'addresses': addresses}) as Map;
      final peers = (((await app.api.get('/sync')) as Map)['peers'] as List).length;
      if (!mounted) return;
      setState(() { _p = p; _peers = peers; });
      _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) async {
        final s = await app.api.get('/sync').catchError((_) => null);
        if (s is Map && (s['peers'] as List).length > (_peers ?? 0) && mounted) Navigator.pop(context);
      });
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _p;
    final at = ((p?['offer'] as Map?)?['at'] as List?)?.cast<String>() ?? const [];
    return AlertDialog(
      title: const Tx('Pair a phone'),
      content: p == null
          ? const SizedBox(height: 120, child: Center(child: CircularProgressIndicator()))
          : Column(mainAxisSize: MainAxisSize.min, children: [
              const Tx('On your phone, open Carino → Settings → Devices → Pair with my PC, and scan this:', textAlign: TextAlign.center),
              const SizedBox(height: 10),
              Container(color: Colors.white, padding: const EdgeInsets.all(8), child: QrImageView(data: '${p['link']}', size: 220)),
              const SizedBox(height: 8),
              SelectableText('Or type the code ${p['code']}${at.isNotEmpty ? ' and the address ${at.first}' : ''}.', textAlign: TextAlign.center),
              const SizedBox(height: 4),
              const Tx('The code works for 10 minutes.', style: TextStyle(fontSize: 12)),
            ]),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Tx('Close'))],
    );
  }
}

/// Records changed on both devices: side by side; the user chooses which to keep.
class _Conflicts extends StatelessWidget {
  final List<Map> conflicts;
  final VoidCallback onDone;
  const _Conflicts({required this.conflicts, required this.onDone});

  String _label(Object? r) {
    if (r is! Map) return '(deleted)';
    return '${r['title'] ?? r['name'] ?? r['content'] ?? r['note'] ?? r['label'] ?? r['source'] ?? r['amount'] ?? r['id']}';
  }

  @override
  Widget build(BuildContext context) {
    if (conflicts.isEmpty) return const SizedBox.shrink();
    final api = AppState.read(context).api;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Tx('Changed on both devices', style: Theme.of(context).textTheme.titleMedium),
      const Tx('These were edited on both before they could sync. Nothing was overwritten: choose which to keep.', style: TextStyle(fontSize: 12)),
      for (final c in conflicts)
        Card(
          margin: const EdgeInsets.only(top: 10),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Tx('{0} · with {1}', args: [_tables[c['tbl']] ?? c['tbl'], c['peer_name'] ?? 'the other device'], style: const TextStyle(fontSize: 12)),
              const SizedBox(height: 6),
              Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Tx('This device', style: TextStyle(fontSize: 11)), Text(_label(c['mine']), style: const TextStyle(fontWeight: FontWeight.w600))])),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('${c['peer_name'] ?? 'Other device'}', style: const TextStyle(fontSize: 11)), Text(_label(c['theirs']), style: const TextStyle(fontWeight: FontWeight.w600))])),
              ]),
              const SizedBox(height: 6),
              Wrap(spacing: 8, children: [
                OutlinedButton(onPressed: () => api.post('/sync/conflicts/${c['id']}', {'keep': 'mine'}).then((_) => onDone()), child: const Tx('Keep this device’s')),
                OutlinedButton(onPressed: () => api.post('/sync/conflicts/${c['id']}', {'keep': 'theirs'}).then((_) => onDone()), child: Tx('Keep {0}’s', args: [c['peer_name'] ?? 'the other'])),
              ]),
            ]),
          ),
        ),
    ]);
  }
}
