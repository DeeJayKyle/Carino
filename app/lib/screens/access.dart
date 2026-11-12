import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Everything Carino can reach, in one place, each with a way to take it back: who answers chats,
/// folders, apps on the PC, signed-in accounts, connected tools, paired devices and messaging.
class AccessScreen extends StatefulWidget {
  /// Inside Settings: no app bar of its own.
  final bool embedded;
  const AccessScreen({super.key, this.embedded = false});
  @override
  State<AccessScreen> createState() => _AccessScreenState();
}

class _AccessScreenState extends State<AccessScreen> {
  final Map<String, Map?> _d = {};
  List<Map>? _pcApps;
  Object? _error;

  bool get _isPc => defaultTargetPlatform == TargetPlatform.windows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = AppState.read(context).api;
    try {
      final r = await Future.wait(['/files', '/apps', '/connectors', '/sync', '/channels'].map((p) => api.get(p).then((v) => v as Map?).catchError((_) => null)));
      List<Map>? pc;
      if (_isPc) pc = await Device(api).listApps().catchError((_) => <Map>[]);
      if (!mounted) return;
      setState(() {
        for (final (i, k) in ['files', 'apps', 'connectors', 'sync', 'channels'].indexed) {
          _d[k] = r[i];
        }
        _pcApps = pc;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _revoke(String what, String body, Future<void> Function() fn) async {
    if (!await confirmDialog(context, title: 'Remove $what?', body: body, confirm: 'Remove', danger: true)) return;
    try {
      await fn();
      if (mounted) toast(context, 'Removed $what');
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final api = app.api;
    final providers = ((app.me?['server'] as Map?)?['providers'] as List? ?? const []).cast<Map>();
    final chosen = (app.settings['ai'] as Map?)?['provider'];
    final ai = providers.where((p) => p['id'] == chosen && p['configured'] == true).firstOrNull ?? providers.where((p) => p['configured'] == true).firstOrNull;
    final local = (ai?['capabilities'] as Map?)?['local'] == true;
    final accounts = [
      for (final p in ((_d['apps']?['apps'] as List?) ?? const []).cast<Map>())
        for (final a in ((p['accounts'] as List?) ?? const []).cast<Map>()) {...a, 'provider': p['label']},
    ];
    String channelName(Object? k) => k == 'whatsapp' ? 'WhatsApp' : k == 'telegram' ? 'Telegram' : '$k';

    final body = _error != null && _d.isEmpty
        ? ErrorPanel(error: _error!, retry: _load)
        : RefreshIndicator(
            onRefresh: _load,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
              _Group(icon: local ? Icons.lock_outline : Icons.public, title: 'Who answers your chats', empty: 'No AI service set up yet.', items: [
                if (ai != null)
                  _Item(
                    name: '${ai['label']}',
                    detail: local ? 'Runs on this device: your messages stay here.' : 'Online: your messages, plus the memories and file text needed to answer, are sent to it.',
                    action: TextButton(onPressed: () => openPath(context, '/settings#ai'), child: const Text('Change')),
                  ),
              ]),
              _Group(icon: Icons.folder_outlined, title: 'Folders', more: () => openPath(context, '/files'), moreLabel: 'Files', empty: 'No folders shared.', items: [
                for (final f in ((_d['files']?['folders'] as List?) ?? const []).cast<Map>())
                  _Item(
                    name: '${f['label']}',
                    detail: f['can_change'] == true ? 'Can read · can change with your OK' : 'Read only',
                    action: _RemoveBtn(() => _revoke('${f['label']}', 'Carino stops reading it and forgets what it noted. Your files aren’t touched.', () async {
                      await api.delete('/files/folders/${f['id']}');
                      await Device(api).forgetFolder('${f['root']}').catchError((_) {});
                    })),
                  ),
              ]),
              if (_isPc)
                _Group(
                  icon: Icons.apps,
                  title: 'Apps on this PC',
                  more: () async {
                    try {
                      final a = await Device(api).pickApp();
                      if (a != null && context.mounted) toast(context, '${a['name']} can now be opened by Carino');
                      await _load();
                    } catch (e) {
                      if (context.mounted) toast(context, errorText(e), error: true);
                    }
                  },
                  moreLabel: 'Add an app',
                  empty: 'None. Add an app (like Excel) so Carino can open it for you, with a file if you like. It can’t control apps once they’re open.',
                  items: [
                    for (final a in _pcApps ?? const <Map>[])
                      _Item(name: '${a['name']}', detail: 'Can be opened by Carino', action: _RemoveBtn(() => _revoke('${a['name']}', 'Carino can no longer open it.', () => Device(api).forgetApp('${a['id']}')))),
                  ],
                ),
              _Group(icon: Icons.person_outline, title: 'Signed-in accounts', more: () => openPath(context, '/apps'), moreLabel: 'Apps', empty: 'No accounts connected.', items: [
                for (final a in accounts)
                  _Item(
                    name: '${a['provider']}: ${a['label']}',
                    detail: a['last_error'] != null ? 'Problem: ${a['last_error']}' : 'Reads with your OK per app settings; sending and posting always ask first.',
                    action: _RemoveBtn(() => _revoke('${a['provider']} (${a['label']})', 'Carino signs out of this account and deletes its saved sign-in.', () => api.delete('/apps/accounts/${a['id']}'))),
                  ),
              ]),
              _Group(icon: Icons.link, title: 'Connected tools', more: () => openPath(context, '/connectors'), moreLabel: 'Connectors', empty: 'No connected tools.', items: [
                for (final c in ((_d['connectors']?['connectors'] as List?) ?? const []).cast<Map>())
                  _Item(
                    name: '${c['name']}',
                    detail: '${Uri.tryParse('${c['url']}')?.host ?? c['url']} · ${(c['tools'] as List?)?.length ?? 0} tool${(c['tools'] as List?)?.length == 1 ? '' : 's'}${c['enabled'] == true ? '' : ' · switched off'}',
                    action: _RemoveBtn(() => _revoke('${c['name']}', 'Carino disconnects it and forgets its saved sign-in.', () => api.delete('/connectors/${c['id']}'))),
                  ),
              ]),
              _Group(icon: Icons.devices, title: 'Paired devices', more: () => openPath(context, '/settings#devices'), moreLabel: 'Devices', empty: 'No paired devices.', items: [
                for (final p in ((_d['sync']?['peers'] as List?) ?? const []).cast<Map>())
                  _Item(
                    name: '${p['name']}',
                    detail: p['confirmed'] == true ? 'Keeps your data in step over your Wi-Fi' : 'Waiting for the check number',
                    action: _RemoveBtn(() => _revoke('${p['name']}', 'They stop syncing. Nothing already on either device is deleted.', () => api.delete('/sync/peers/${p['device_id']}'))),
                  ),
              ]),
              _Group(icon: Icons.chat_outlined, title: 'Messaging', more: () => openPath(context, '/messaging'), moreLabel: 'Messaging', empty: 'No messaging channels.', items: [
                for (final ch in ((_d['channels']?['channels'] as List?) ?? const []).cast<Map>())
                  _Item(
                    name: channelName(ch['kind']),
                    detail: '${(ch['chats'] as List?)?.length ?? 0} chat${(ch['chats'] as List?)?.length == 1 ? '' : 's'} can talk to Carino',
                    action: _RemoveBtn(() => _revoke(channelName(ch['kind']), 'Carino stops answering there.', () => api.delete('/channels/${ch['id']}'))),
                  ),
              ]),
            ]),
          );
    if (widget.embedded) return body;
    return Scaffold(appBar: AppBar(title: const Text('What Carino can reach')), body: body);
  }
}

class _Group extends StatelessWidget {
  final IconData icon;
  final String title;
  final String empty;
  final List<Widget> items;
  final VoidCallback? more;
  final String? moreLabel;
  const _Group({required this.icon, required this.title, required this.empty, required this.items, this.more, this.moreLabel});

  @override
  Widget build(BuildContext context) {
    final muted = Theme.of(context).colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(icon, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
          if (more != null) TextButton(onPressed: more, child: Text(moreLabel ?? 'More')),
        ]),
        if (items.isEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(empty, style: TextStyle(color: muted, fontSize: 13))) else ...items,
      ]),
    );
  }
}

class _Item extends StatelessWidget {
  final String name;
  final String detail;
  final Widget? action;
  const _Item({required this.name, required this.detail, this.action});
  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        dense: true,
        title: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(detail),
        trailing: action,
      );
}

class _RemoveBtn extends StatelessWidget {
  final VoidCallback onPressed;
  const _RemoveBtn(this.onPressed);
  @override
  Widget build(BuildContext context) => TextButton.icon(onPressed: onPressed, icon: const Icon(Icons.close, size: 16), label: const Text('Remove'));
}
