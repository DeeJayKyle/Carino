import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

class _About {
  final String name;
  final List<String> parts;
  final List<String> does;
  final bool beta;
  const _About(this.name, this.does, {this.parts = const [], this.beta = false});
}

const _about = {
  'google': _About('Google', ['Find, read, draft and send email', 'See and add calendar events (with Meet links)', 'Find and read Drive files; save attachments to Drive', 'Read and fill in Google Sheets; create Sheets and Docs'], parts: ['Gmail', 'Calendar', 'Drive', 'Sheets', 'Docs']),
  'microsoft': _About('Microsoft', ['Find, read, draft and send Outlook email', 'See and add Outlook calendar events (with Teams links)', 'Find and read OneDrive files', 'Write Word documents, Excel workbooks and PowerPoint decks; read and update Excel'], parts: ['Outlook', 'Calendar', 'OneDrive', 'Word', 'Excel', 'PowerPoint']),
  'instagram': _About('Instagram', ['See your profile, posts, likes and comments', 'Reply to comments', 'Post a photo you attach, with a caption'], beta: true),
  'facebook': _About('Facebook', ['See your Pages’ posts and comments', 'Post to a Page (text, link or photo)', 'Reply to comments as the Page'], beta: true),
  'x': _About('X (Twitter)', ['Post and reply as you', 'See your profile and recent posts (X’s free plan allows very few reads)'], beta: true),
  'linkedin': _About('LinkedIn', ['Post as you, with a link if you like'], beta: true),
  'tiktok': _About('TikTok', ['Send a video you attach to TikTok as a draft, ready for you to finish and post'], beta: true),
  'slack': _About('Slack', ['Read channels and search messages', 'Send a message or thread reply as you (after your OK)']),
  'todoist': _About('Todoist', ['See your tasks, by any Todoist filter', 'Add tasks and tick them off']),
  'ticktick': _About('TickTick', ['See your lists and tasks', 'Add tasks and tick them off']),
  'notion': _About('Notion', ['Search and read the pages you share with Carino', 'Create pages and add notes to them']),
  'linear': _About('Linear', ['See issues assigned to you', 'Create issues and comment (after your OK)']),
  'github': _About('GitHub', ['See notifications, assigned issues and review requests', 'Read issues; open issues and comment (after your OK)']),
  'withings': _About('Withings', ['Read weight, blood pressure, heart rate, activity and sleep from your Withings devices'], beta: true),
  'sonos': _About('Sonos', ['See what’s playing in each room', 'Play, pause, skip and change the volume'], beta: true),
};

const _workApps = ['slack', 'todoist', 'ticktick', 'notion', 'linear', 'github', 'withings', 'sonos'];

/// Simple marks drawn here (no images are loaded from the web).
class AppMark extends StatelessWidget {
  final String id;
  final double size;
  const AppMark(this.id, {super.key, this.size = 44});
  static const _marks = {
    'google': (Color(0xFF4285F4), 'G'), 'microsoft': (Color(0xFF00A4EF), 'M'), 'facebook': (Color(0xFF1877F2), 'f'), 'instagram': (Color(0xFFD62976), 'IG'),
    'x': (Color(0xFF111111), 'X'), 'linkedin': (Color(0xFF0A66C2), 'in'), 'tiktok': (Color(0xFF222222), 'TT'), 'whatsapp': (Color(0xFF25D366), 'W'), 'telegram': (Color(0xFF2AABEE), 'T'),
    'slack': (Color(0xFF4A154B), '#'), 'todoist': (Color(0xFFE44332), 'td'), 'ticktick': (Color(0xFF4772FA), '✓'), 'notion': (Color(0xFF000000), 'N'),
    'linear': (Color(0xFF5E6AD2), 'L'), 'github': (Color(0xFF24292F), 'gh'), 'withings': (Color(0xFF00B3B0), 'W'), 'sonos': (Color(0xFF000000), 'S'),
  };
  @override
  Widget build(BuildContext context) {
    final m = _marks[id];
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: m?.$1 ?? Theme.of(context).colorScheme.secondaryContainer, borderRadius: BorderRadius.circular(size / 4)),
      child: m == null ? Icon(Icons.more_horiz, color: Theme.of(context).colorScheme.onSecondaryContainer) : Text(m.$2, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * 0.38)),
    );
  }
}

/// Steps for the user's own (free) developer app at each provider. Each step: text, and a link.
({List<(String, String?)> steps, String? note, String idLabel, String secretLabel}) _guide(String group, String redirect) {
  switch (group) {
    case 'google':
      return (idLabel: 'Client ID', secretLabel: 'Client secret', steps: [
        ('Open Google Cloud and create a project (any name, e.g. “Carino”). It’s free.', 'https://console.cloud.google.com/projectcreate'),
        ('In APIs & Services → Library, turn on Gmail API, Google Calendar API, Google Drive API, Google Sheets API and Google Docs API.', 'https://console.cloud.google.com/apis/library'),
        ('Open Google Auth Platform → Get started: app name “Carino”, your email, audience External. Then under Audience tap Publish app (otherwise Google signs you out every 7 days).', 'https://console.cloud.google.com/auth/overview'),
        ('Under Clients → Create client, choose Desktop app. Copy the Client ID and Client secret here.', null),
      ], note: 'When you sign in, Google says the app isn’t verified — that’s expected for your own app. Tap Advanced → Go to Carino. For a second Google account, just sign in again.');
    case 'microsoft':
      return (idLabel: 'Application (client) ID', secretLabel: '', steps: [
        ('Open Microsoft Entra → App registrations (free, sign in with your Microsoft account) and tap New registration.', 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'),
        ('Name it “Carino”. Who can use it: Accounts in any organizational directory and personal Microsoft accounts.', null),
        ('Redirect URI: choose Public client/native (mobile & desktop) and enter $redirect. Tap Register.', null),
        ('Copy the Application (client) ID here. No secret is needed.', null),
      ], note: 'Work or school accounts may need their IT admin to allow the app.');
    case 'meta':
      return (idLabel: 'App ID', secretLabel: 'App secret', steps: [
        ('Open Meta for Developers → Create app (free). Choose the use cases Manage everything on your Page and Manage messaging & content on Instagram.', 'https://developers.facebook.com/apps/creation/'),
        ('In App settings → Basic, copy the App ID and App secret here.', null),
        ('In Facebook Login → Settings, add this to Valid OAuth Redirect URIs: $redirect', null),
        ('Leave the app in Development mode: as its admin you can use it without Meta’s review.', null),
      ], note: 'Facebook lets apps post to Pages you manage, not your personal profile. Instagram needs a Business or Creator account linked to one of your Pages. One Meta app works for Facebook, Instagram and WhatsApp.');
    case 'x':
      return (idLabel: 'OAuth 2.0 Client ID', secretLabel: 'Client secret (if shown)', steps: [
        ('Open the X Developer Portal and sign up for the Free plan.', 'https://developer.x.com/en/portal/dashboard'),
        ('In your app → User authentication settings → Set up: permissions Read and write, type Native App.', null),
        ('Callback URI: $redirect — website: any link of yours.', null),
        ('Under Keys and tokens, copy the OAuth 2.0 Client ID (and secret, if X shows one) here.', null),
      ], note: 'X’s free plan allows about 500 posts a month and very few reads.');
    case 'linkedin':
      return (idLabel: 'Client ID', secretLabel: 'Client secret', steps: [
        ('Open LinkedIn Developers → Create app (free). LinkedIn asks for a Page to link it to; any Page you manage works.', 'https://www.linkedin.com/developers/apps/new'),
        ('Under Products, add Sign In with LinkedIn using OpenID Connect and Share on LinkedIn.', null),
        ('Under Auth, add this Authorized redirect URL: $redirect', null),
        ('Copy the Client ID and Client secret here.', null),
      ], note: 'LinkedIn sign-ins last 60 days; Carino tells you when to sign in again.');
    case 'ticktick':
      return (idLabel: 'Client ID', secretLabel: 'Client secret', steps: [
        ('Open the TickTick Developer Center and tap Manage Apps → + App Name (free).', 'https://developer.ticktick.com/manage'),
        ('Set the OAuth redirect URL to $redirect', null),
        ('Copy the Client ID and Client secret here.', null),
      ], note: null);
    case 'withings':
      return (idLabel: 'Client ID', secretLabel: 'Consumer secret', steps: [
        ('Open the Withings developer dashboard and create a Public API integration (free, for your own use).', 'https://developer.withings.com/dashboard/'),
        ('Add this callback URL: $redirect', null),
        ('Copy the Client ID and Consumer secret here.', null),
      ], note: 'Health data is only read, never changed, and stays on this device.');
    case 'sonos':
      return (idLabel: 'Key', secretLabel: 'Secret', steps: [
        ('Open the Sonos developer portal and create a Control integration (free).', 'https://developer.sonos.com/'),
        ('Add a Key and set its redirect URI to $redirect', null),
        ('Copy the Key and Secret here.', null),
      ], note: 'Sonos only accepts web (https) redirect addresses. If it won’t take the one above, use Carino from a computer at an https address, or skip Sonos for now.');
    default:
      return (idLabel: 'Client key', secretLabel: 'Client secret', steps: [
        ('Open TikTok for Developers → Manage apps and connect a new app (free).', 'https://developers.tiktok.com/apps/'),
        ('Add the products Login Kit and Content Posting API. Platform: Desktop. Redirect URI: $redirect', null),
        ('Turn on Sandbox and add your TikTok account under Target users (no review needed for your own account).', null),
        ('Copy the Client key and Client secret here.', null),
      ], note: 'Videos arrive in your TikTok notifications as drafts; you add the sound and caption and post them yourself.');
  }
}

/// Reloads when a sign-in finishes in the browser (the engine's "carino-apps-changed").
mixin _AppsChanged<T extends StatefulWidget> on State<T> {
  StreamSubscription<String>? _changes;
  void onAppsChanged();
  @override
  void initState() {
    super.initState();
    _changes = AppState.read(context).engine.opens.where((p) => p == 'event:carino-apps-changed').listen((_) => onAppsChanged());
  }

  @override
  void dispose() {
    _changes?.cancel();
    super.dispose();
  }
}

/// My apps: accounts Carino can use (Google, Microsoft, social), plus WhatsApp, Telegram and more.
class AppsScreen extends StatefulWidget {
  final String? id;
  const AppsScreen({super.key, this.id});
  @override
  State<AppsScreen> createState() => _AppsScreenState();
}

class _AppsScreenState extends State<AppsScreen> with _AppsChanged {
  List<Map>? _apps;
  List<Map> _channels = const [];
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void onAppsChanged() => _load();

  Future<void> _load() async {
    final api = AppState.read(context).api;
    try {
      final r = await api.get('/apps') as Map;
      final c = await api.get('/channels').catchError((_) => {'channels': []}) as Map;
      if (mounted) setState(() { _apps = (r['apps'] as List).cast<Map>(); _channels = ((c['channels'] as List?) ?? const []).cast<Map>(); _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = _apps;
    if (list != null && widget.id != null) {
      final app = list.where((a) => a['id'] == widget.id).firstOrNull;
      if (app != null) return AppDetail(app: app, reload: _load);
    }
    final wa = _channels.where((c) => c['kind'] == 'whatsapp').firstOrNull;
    final tg = _channels.where((c) => c['kind'] == 'telegram').firstOrNull;
    Widget item({required String logo, required String name, required String status, bool? ok, bool beta = false, String? badge, List<String>? parts, bool warn = false, required String to}) {
      final cs = Theme.of(context).colorScheme;
      return Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ListTile(
          leading: AppMark(logo),
          title: Row(children: [Flexible(child: Text(name)), if (beta) const Padding(padding: EdgeInsets.only(left: 6), child: Pill('Beta')), if (badge != null) Padding(padding: const EdgeInsets.only(left: 6), child: Pill(badge))]),
          subtitle: parts != null
              ? Wrap(spacing: 4, runSpacing: 4, children: [for (final p in parts) Pill(p, color: cs.secondary)])
              : Row(children: [
                  if (ok != null) Padding(padding: const EdgeInsets.only(right: 6), child: Icon(Icons.circle, size: 8, color: warn ? cs.error : ok ? Colors.green : cs.outline)),
                  Expanded(child: Text(status, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: warn ? cs.error : null))),
                ]),
          trailing: const Icon(Icons.chevron_right),
          onTap: () async {
            if (to.startsWith('/apps/')) {
              await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AppsScreen(id: to.substring(6))));
              _load();
            } else {
              await openPath(context, to);
              _load();
            }
          },
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('My apps')),
      body: list == null
          ? (_error != null ? ErrorPanel(error: _error!, retry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
                Text('Connect your accounts so Carino can read and act for you. Sending email and posting always waits for your OK.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
                const SizedBox(height: 12),
                item(logo: 'whatsapp', name: 'WhatsApp', beta: true, to: '/messaging#whatsapp',
                    ok: (wa?['config'] as Map?)?['relay_url'] != null && wa?['enabled'] == true,
                    status: (wa?['config'] as Map?)?['relay_url'] != null ? (wa!['enabled'] == true ? 'Connected' : 'Turned off') : 'Tap to set up'),
                for (final pid in const ['google', 'microsoft', 'instagram', 'facebook', 'x', 'linkedin', 'tiktok'])
                  if (list.where((x) => x['id'] == pid).firstOrNull case final a?)
                    () {
                      final accts = (a['accounts'] as List).cast<Map>();
                      final warn = accts.any((x) => x['last_error'] != null);
                      final n = accts.length;
                      return item(
                        logo: pid, name: _about[pid]!.name, beta: _about[pid]!.beta, to: '/apps/$pid', ok: n > 0, warn: warn,
                        badge: n > 1 ? '$n accounts' : null,
                        parts: n > 0 && !warn && _about[pid]!.parts.isNotEmpty ? _about[pid]!.parts : null,
                        status: n > 0 ? (warn ? 'Needs you to sign in again' : n == 1 ? '${accts.first['label']}' : 'Connected') : 'Tap to connect',
                      );
                    }(),
                Padding(padding: const EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text('Work & life', style: Theme.of(context).textTheme.titleSmall)),
                for (final pid in _workApps)
                  if (list.where((x) => x['id'] == pid).firstOrNull case final a?)
                    () {
                      final accts = (a['accounts'] as List).cast<Map>();
                      final warn = accts.any((x) => x['last_error'] != null);
                      return item(
                        logo: pid, name: _about[pid]!.name, beta: _about[pid]!.beta, to: '/apps/$pid', ok: accts.isNotEmpty, warn: warn,
                        status: accts.isNotEmpty ? (warn ? 'Needs attention' : '${accts.first['label']}') : 'Tap to connect',
                      );
                    }(),
                const SizedBox(height: 8),
                item(logo: 'telegram', name: 'Telegram', to: '/messaging', ok: tg?['enabled'] == true,
                    status: tg != null ? (tg['enabled'] == true ? 'Connected · @${(tg['config'] as Map?)?['bot_username']}' : 'Turned off') : 'Tap to set up'),
                item(logo: 'more', name: 'More apps', to: '/connectors', status: 'Zapier and other MCP apps'),
              ]),
            ),
    );
  }
}

class AppDetail extends StatefulWidget {
  final Map app;
  final Future<void> Function() reload;
  const AppDetail({super.key, required this.app, required this.reload});
  @override
  State<AppDetail> createState() => _AppDetailState();
}

class _AppDetailState extends State<AppDetail> {
  late final _clientId = TextEditingController(text: '${(widget.app['client'] as Map?)?['client_id'] ?? ''}');
  late final _secret = TextEditingController(text: (widget.app['client'] as Map?)?['has_secret'] == true ? '••••••••' : '');
  final _token = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _clientId.dispose();
    _secret.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _connectKey() async {
    final api = AppState.read(context).api;
    setState(() => _busy = true);
    try {
      final r = await api.post('/apps/${app['id']}/key', {'token': _token.text.trim()}) as Map;
      _token.clear();
      if (mounted) toast(context, 'Connected ${(r['account'] as Map?)?['label'] ?? about.name}');
      await widget.reload();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Map get app => widget.app;
  _About get about => _about[app['id']]!;

  Future<void> _signIn() async {
    final api = AppState.read(context).api;
    setState(() => _busy = true);
    try {
      final r = await api.post('/apps/${app['id']}/start', {}) as Map;
      final err = await Device(api).openSignIn('${r['authorize_url']}');
      if (mounted) toast(context, err ?? 'Finish signing in to ${about.name} in your browser', error: err != null);
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final api = AppState.read(context).api;
    setState(() => _busy = true);
    try {
      final s = _secret.text.trim();
      await api.put('/apps/clients/${app['group']}', {'client_id': _clientId.text.trim(), if (s.isNotEmpty && !s.startsWith('••••')) 'client_secret': s});
      if (mounted) toast(context, 'Saved. Now sign in.');
      await widget.reload();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final cs = Theme.of(context).colorScheme;
    final g = _guide('${app['group']}', '${app['redirect_uri']}');
    final client = app['client'] as Map?;
    final oneTap = app['one_tap'] == true;
    final accounts = (app['accounts'] as List).cast<Map>();
    final key = app['key'] as Map?;
    final shared = app['group'] == 'meta' ? (app['id'] == 'facebook' ? 'Instagram' : 'Facebook') : null;
    return Scaffold(
      appBar: AppBar(title: Text(about.name)),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              AppMark('${app['id']}', size: 56),
              const SizedBox(width: 14),
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [Text(about.name, style: Theme.of(context).textTheme.titleLarge), if (about.beta) const Padding(padding: EdgeInsets.only(left: 8), child: Pill('Beta'))]),
                for (final d in about.does) Padding(padding: const EdgeInsets.only(top: 3), child: Text('• $d', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant))),
              ])),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        Text('Accounts', style: Theme.of(context).textTheme.titleMedium),
        if (accounts.isEmpty) const Padding(padding: EdgeInsets.only(top: 4), child: Text('Not connected yet.')),
        for (final a in accounts)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(Icons.circle, size: 10, color: a['last_error'] == null ? Colors.green : cs.error),
            title: Text('${a['label']}'),
            subtitle: a['last_error'] != null ? Text('${a['last_error']}', style: TextStyle(color: cs.error)) : null,
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              if (a['last_error'] != null && key == null) TextButton(onPressed: _busy ? null : _signIn, child: const Text('Sign in again')),
              IconButton(
                tooltip: 'Disconnect ${a['label']}',
                icon: const Icon(Icons.close),
                onPressed: () async {
                  if (!await confirmDialog(context, title: 'Disconnect ${a['label']}?', body: 'Carino forgets this ${about.name} sign-in. Nothing in your account is changed.', confirm: 'Disconnect', danger: true)) return;
                  try {
                    await api.delete('/apps/accounts/${a['id']}');
                  } catch (e) {
                    if (context.mounted) toast(context, errorText(e), error: true);
                  }
                  await widget.reload();
                },
              ),
            ]),
          ),
        if (key != null) ...[
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(accounts.isEmpty ? 'Connect with a personal token' : 'Add another account', style: Theme.of(context).textTheme.titleSmall),
                const SizedBox(height: 6),
                Text('${key['steps']}', style: const TextStyle(fontSize: 13)),
                TextButton.icon(style: TextButton.styleFrom(padding: EdgeInsets.zero), onPressed: () => Device(api).openExternal('${key['url']}'), icon: const Icon(Icons.open_in_new, size: 14), label: Text('Open ${about.name}')),
                TextField(controller: _token, obscureText: true, autocorrect: false, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: 'Token', hintText: '${key['placeholder']}')),
                const SizedBox(height: 10),
                FilledButton(onPressed: _busy || _token.text.trim().length < 8 ? null : _connectKey, child: const Text('Connect')),
              ]),
            ),
          ),
          const SizedBox(height: 10),
          Text('The token is stored encrypted on this device and only sent to ${about.name}. Changes and messages wait for your OK unless you allow them in Settings → Permissions.', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
        ] else ...[
        const SizedBox(height: 8),
        FilledButton.icon(
          onPressed: _busy || (client == null && !oneTap) ? null : _signIn,
          icon: const Icon(Icons.lock_outline, size: 18),
          label: Text(accounts.isNotEmpty ? 'Add another ${about.name} account' : 'Sign in with ${about.name}'),
        ),
        if (client == null && !oneTap) const Padding(padding: EdgeInsets.only(top: 4), child: Text('First do the one-time setup below.', style: TextStyle(fontSize: 12))),
        if (oneTap && client == null) Padding(padding: const EdgeInsets.only(top: 10), child: Text('You sign in on ${about.name}’s own page and choose what Carino may do. Your sign-in is kept on this phone.', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant))),
        const SizedBox(height: 12),
        Card(
          child: ExpansionTile(
            initiallyExpanded: client == null && !oneTap,
            title: Text(oneTap ? 'Advanced: use my own developer app' : 'One-time setup'),
            subtitle: oneTap ? null : const Text('About 5 minutes, free'),
            childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            expandedCrossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Carino talks to ${about.name} directly from your phone, with your own free developer app — nothing goes through anyone else’s server.${shared != null ? ' This is the same Meta app as $shared: set it up once for both.' : ''}', style: const TextStyle(fontSize: 13)),
              const SizedBox(height: 8),
              for (final (i, (text, url)) in g.steps.indexed)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${i + 1}. ', style: const TextStyle(fontWeight: FontWeight.w700)),
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(text, style: const TextStyle(fontSize: 13)),
                      if (url != null) TextButton.icon(style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact), onPressed: () => Device(api).openExternal(url), icon: const Icon(Icons.open_in_new, size: 14), label: const Text('Open')),
                    ])),
                  ]),
                ),
              if (g.note != null) Card(color: cs.secondaryContainer, child: Padding(padding: const EdgeInsets.all(10), child: Text(g.note!, style: TextStyle(fontSize: 13, color: cs.onSecondaryContainer)))),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(child: SelectableText('${app['redirect_uri']}', style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
                TextButton.icon(onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: '${app['redirect_uri']}'));
                  if (context.mounted) toast(context, 'Copied');
                }, icon: const Icon(Icons.copy, size: 16), label: const Text('Copy')),
              ]),
              TextField(controller: _clientId, autocorrect: false, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: g.idLabel)),
              if (g.secretLabel.isNotEmpty)
                TextField(controller: _secret, obscureText: true, autocorrect: false, onTap: () { if (_secret.text.startsWith('••••')) _secret.clear(); }, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: g.secretLabel)),
              const SizedBox(height: 10),
              Row(children: [
                OutlinedButton(onPressed: _busy || _clientId.text.trim().length < 4 || (app['needs_secret'] == true && _secret.text.trim().isEmpty) ? null : _save, child: const Text('Save')),
                if (client != null)
                  TextButton(
                    onPressed: () async {
                      if (!await confirmDialog(context, title: 'Remove the developer app?', body: 'Signed-in accounts keep working until their sign-in expires.', confirm: 'Remove', danger: true)) return;
                      await api.delete('/apps/clients/${app['group']}');
                      _clientId.clear();
                      _secret.clear();
                      await widget.reload();
                    },
                    child: const Text('Remove'),
                  ),
              ]),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Text('Your sign-ins are stored encrypted on this phone. Carino asks before sending email or posting anything. You can change what it may do on its own in Settings → Permissions.', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
        ],
      ]),
    );
  }
}
