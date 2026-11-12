import 'dart:async';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../engine/engine.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Well-known MCP servers. Addresses can change; each app's own docs are authoritative.
const _directory = [
  ('Notion', 'https://mcp.notion.com/mcp', 'Sign in with Notion', Icons.note_outlined),
  ('Linear', 'https://mcp.linear.app/mcp', 'Sign in with Linear', Icons.checklist),
  ('GitHub', 'https://api.githubcopilot.com/mcp/', 'Paste a GitHub personal access token', Icons.code),
  ('Zapier (Gmail, Calendar, Outlook, Slack…)', '', 'Free plan · copy your personal address from mcp.zapier.com', Icons.link),
  ('Composio (Gmail, Calendar, Drive…)', '', 'Free tier · copy your MCP address from composio.dev', Icons.link),
  ('Pipedream (2,000+ apps)', '', 'Free tier · copy your MCP address from mcp.pipedream.com', Icons.link),
];
const _risk = {'read': 'reads only', 'reversible': 'makes changes', 'consequential': 'can delete'};

Future<void> _signIn(BuildContext context, String name, String url) async {
  final api = AppState.read(context).api;
  try {
    final r = await api.post('/connectors/oauth/start', {'name': name, 'url': url}) as Map;
    final err = await Device(api).openSignIn('${r['authorize_url']}');
    if (context.mounted) toast(context, err ?? 'Finish signing in to $name in your browser', error: err != null);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e), error: true);
  }
}

/// Connected apps through MCP: add by address or sign-in, per-tool permissions, tokens.
class ConnectorsScreen extends StatefulWidget {
  const ConnectorsScreen({super.key});
  @override
  State<ConnectorsScreen> createState() => _ConnectorsScreenState();
}

class _ConnectorsScreenState extends State<ConnectorsScreen> {
  Map? _data;
  Object? _error;
  String? _busy;
  String? _open;
  StreamSubscription<String>? _changes;

  @override
  void initState() {
    super.initState();
    _load();
    // A sign-in finished in the browser.
    _changes = AppState.read(context).engine.opens.where((p) => p == 'event:carino-apps-changed').listen((_) => _load());
  }

  @override
  void dispose() {
    _changes?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await AppState.read(context).api.get('/connectors') as Map;
      if (mounted) setState(() { _data = d; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _act(String id, Future<void> Function() fn, [String? done]) async {
    setState(() => _busy = id);
    try {
      await fn();
      if (mounted && done != null) toast(context, done);
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _add({String? name, String? url}) async {
    final ok = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, builder: (_) => _AddConnector(name: name, url: url));
    if (ok == true) await _load();
  }

  Future<void> _token(Map c) async {
    final api = AppState.read(context).api;
    final t = TextEditingController();
    final r = await showDialog<String?>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Tx('Access token for {0}', args: [c['name']]),
        content: TextField(controller: t, obscureText: true, autofocus: true, decoration: InputDecoration(labelText: tr('New token'))),
        actions: [
          if (c['has_token'] == true) TextButton(onPressed: () => Navigator.pop(ctx, ''), child: const Tx('Remove token')),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Tx('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, t.text.trim()), child: const Tx('Save')),
        ],
      ),
    );
    if (r == null) return;
    await _act('${c['id']}', () => api.patch('/connectors/${c['id']}', {'token': r.isEmpty ? null : r}), r.isEmpty ? 'Token removed' : 'Token saved');
  }

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final cs = Theme.of(context).colorScheme;
    final d = _data;
    final list = ((d?['connectors'] as List?) ?? const []).cast<Map>();
    return Scaffold(
      appBar: AppBar(title: const Tx('Connected apps')),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => _add(), icon: const Icon(Icons.add), label: const Tx('Connect an app')),
      body: d == null
          ? (_error != null ? ErrorPanel(error: _error!, retry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 96), children: [
                Tx('Let Carino use your other apps — email, calendar, notes, project tools — through MCP, the open standard for AI connectors. Carino can read with them freely; anything that sends, changes or deletes waits for your approval unless you say otherwise.', style: TextStyle(color: cs.onSurfaceVariant)),
                const SizedBox(height: 12),
                if (list.isEmpty) EmptyView(icon: Icons.link, title: tr('No apps connected yet'), body: tr('Paste the address of an MCP server. Many apps and connector services give you one.')),
                for (final c in list)
                  Card(
                    margin: const EdgeInsets.only(bottom: 10),
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text('${c['name']}${c['server_name'] != null && c['server_name'] != c['name'] ? ' · ${c['server_name']}' : ''}', style: const TextStyle(fontWeight: FontWeight.w600)),
                            Text('${c['url']}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                            const SizedBox(height: 4),
                            Tx('{0} tool{1} · {2}{3}', args: [(c['tools'] as List).length, (c['tools'] as List).length == 1 ? '' : 's', c['signed_in'] == true ? tr('signed in') : c['has_token'] == true ? tr('token saved') : tr('no token'), c['last_checked_at'] != null ? ' · checked ${fmtDateTime('${c['last_checked_at']}')}' : ''], style: const TextStyle(fontSize: 13)),
                            if (c['last_error'] != null) Text('${c['last_error']}', style: TextStyle(fontSize: 13, color: cs.error)),
                          ])),
                          Switch(value: c['enabled'] == true, onChanged: (v) => _act('${c['id']}', () => api.patch('/connectors/${c['id']}', {'enabled': v}))),
                        ]),
                        Wrap(spacing: 4, children: [
                          TextButton.icon(onPressed: () => setState(() => _open = _open == c['id'] ? null : '${c['id']}'), icon: const Icon(Icons.tune, size: 16), label: Text(_open == c['id'] ? 'Hide tools' : 'Tools & permissions')),
                          TextButton.icon(onPressed: _busy == c['id'] ? null : () => _act('${c['id']}', () => api.post('/connectors/${c['id']}/refresh', {}), 'Tool list refreshed'), icon: const Icon(Icons.refresh, size: 16), label: Text(_busy == c['id'] ? 'Checking…' : 'Refresh')),
                          if (c['signed_in'] == true)
                            TextButton.icon(onPressed: () => _signIn(context, '${c['name']}', '${c['url']}'), icon: const Icon(Icons.lock_outline, size: 16), label: const Tx('Sign in again'))
                          else
                            TextButton.icon(onPressed: () => _token(c), icon: const Icon(Icons.key, size: 16), label: Text(c['has_token'] == true ? 'Change token' : 'Add token')),
                          TextButton.icon(
                            onPressed: () async {
                              if (!await confirmDialog(context, title: tr('Disconnect {0}?', [c['name']]), body: tr('Carino will stop using it and its saved token is deleted. Past chats are kept.'), confirm: tr('Disconnect'), danger: true)) return;
                              await _act('${c['id']}', () => api.delete('/connectors/${c['id']}'), '${c['name']} disconnected');
                            },
                            icon: const Icon(Icons.delete_outline, size: 16),
                            label: const Tx('Disconnect'),
                          ),
                        ]),
                        if (_open == c['id']) ...[
                          if ((c['tools'] as List).isEmpty) const Padding(padding: EdgeInsets.all(8), child: Tx('This app offers no tools.')),
                          for (final t in (c['tools'] as List).cast<Map>())
                            ListTile(
                              contentPadding: EdgeInsets.zero,
                              dense: true,
                              title: Row(children: [
                                Flexible(child: Text('${t['title'] ?? t['name']}', style: const TextStyle(fontWeight: FontWeight.w600))),
                                const SizedBox(width: 6),
                                Pill(_risk[t['risk']] ?? '${t['risk']}', color: t['risk'] == 'consequential' ? cs.error : t['risk'] == 'read' ? cs.outline : cs.tertiary),
                              ]),
                              subtitle: Text('${t['description'] ?? ''}', maxLines: 3, overflow: TextOverflow.ellipsis),
                              trailing: DropdownButton<String>(
                                value: '${t['mode']}',
                                items: [
                                  if (t['risk'] != 'consequential') const DropdownMenuItem(value: 'auto', child: Tx('Allowed')),
                                  const DropdownMenuItem(value: 'ask', child: Tx('Ask me first')),
                                  const DropdownMenuItem(value: 'off', child: Tx('Off')),
                                ],
                                onChanged: (m) => _act('${c['id']}', () => api.patch('/connectors/${c['id']}', {'tool_modes': {'${t['key']}': m}})),
                              ),
                            ),
                        ],
                      ]),
                    ),
                  ),
                const SizedBox(height: 14),
                Tx('Popular free connectors', style: Theme.of(context).textTheme.titleMedium),
                for (final (name, url, how, icon) in _directory)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(icon),
                    title: Text(name),
                    subtitle: Tx(how),
                    trailing: OutlinedButton(onPressed: () => _add(name: name.split(' (').first, url: url), child: const Tx('Connect')),
                  ),
                const SizedBox(height: 10),
                Tx('Where to get an address', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 6),
                Text('• Connector services such as Zapier MCP, Composio or Pipedream link Gmail, Google Calendar, Outlook, Slack, Notion, Todoist and thousands of other apps, and give you one personal MCP address. Sign in there, pick the apps and actions, and paste the address here.\n'
                    '• Apps with their own MCP server (for example GitHub, Linear or Atlassian) list the address and how to create an access token in their documentation. Use the “Streamable HTTP” address — it often ends in /mcp.\n'
                    '• Apps that support it can be connected with Sign in with the app — Carino opens the app’s own sign-in page and never sees your password. Treat an MCP address that includes a key like a password.', style: const TextStyle(fontSize: 13)),
              ]),
            ),
    );
  }
}

class _AddConnector extends StatefulWidget {
  final String? name;
  final String? url;
  const _AddConnector({this.name, this.url});
  @override
  State<_AddConnector> createState() => _AddConnectorState();
}

class _AddConnectorState extends State<_AddConnector> {
  late final _name = TextEditingController(text: widget.name ?? '');
  late final _url = TextEditingController(text: widget.url ?? '');
  final _token = TextEditingController();
  bool _busy = false;
  bool _needsSignIn = false;
  String? _err;

  Future<void> _save() async {
    setState(() { _busy = true; _err = null; });
    try {
      final c = await AppState.read(context).api.post('/connectors', {'name': _name.text.trim(), 'url': _url.text.trim(), if (_token.text.trim().isNotEmpty) 'token': _token.text.trim()}) as Map;
      final n = (c['tools'] as List?)?.length ?? 0;
      if (!mounted) return;
      toast(context, tr('{0} connected — {1} tool{2} available', [c['name'], n, n == 1 ? '' : 's']));
      Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() { _err = errorText(e); _needsSignIn = e is ApiError && e.code == 'needs_sign_in'; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ready = _name.text.trim().isNotEmpty && _url.text.trim().isNotEmpty && !_busy;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('Connect an app', style: Theme.of(context).textTheme.titleLarge),
        TextField(controller: _name, maxLength: 40, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: tr('Name'), hintText: tr('e.g. Work email'))),
        TextField(controller: _url, keyboardType: TextInputType.url, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: tr('MCP server address'), hintText: 'https://…/mcp')),
        TextField(controller: _token, obscureText: true, decoration: InputDecoration(labelText: tr('Access token (optional)'), helperText: tr('Sent to the app as a Bearer token. Stored encrypted and never shown again.'))),
        if (_err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_err!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, children: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Tx('Cancel')),
          OutlinedButton.icon(
            onPressed: ready ? () async {
              setState(() => _busy = true);
              await _signIn(context, _name.text.trim(), _url.text.trim());
              if (mounted) setState(() => _busy = false);
            } : null,
            icon: const Icon(Icons.lock_outline, size: 16),
            label: const Tx('Sign in with the app'),
          ),
          if (_needsSignIn) OutlinedButton(onPressed: ready ? _save : null, child: const Tx('Connect')) else FilledButton(onPressed: ready ? _save : null, child: Text(_busy ? 'Connecting…' : 'Connect')),
        ]),
      ]),
    );
  }
}
