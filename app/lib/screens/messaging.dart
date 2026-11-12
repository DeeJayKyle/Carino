import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Talk to Carino from WhatsApp and Telegram: link chats with a code, mute or unlink them.
class MessagingScreen extends StatefulWidget {
  const MessagingScreen({super.key});
  @override
  State<MessagingScreen> createState() => _MessagingScreenState();
}

class _MessagingScreenState extends State<MessagingScreen> {
  Map? _data;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await AppState.read(context).api.get('/channels') as Map;
      if (mounted) setState(() { _data = d; _error = null; });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    final chans = ((d?['channels'] as List?) ?? const []).cast<Map>();
    final tg = chans.where((c) => c['kind'] == 'telegram').firstOrNull;
    final wa = chans.where((c) => c['kind'] == 'whatsapp').firstOrNull;
    final shared = d?['shared_whatsapp'] as Map?;
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Messaging')),
      body: d == null
          ? (_error != null ? ErrorPanel(error: _error!, retry: _load) : const Center(child: CircularProgressIndicator()))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
                Text('Message Carino from WhatsApp or Telegram as you would a friend — text, voice notes and photos. Add Carino to a family or team group to keep lists and plans in one place. Each chat gets its own conversation here in Carino.', style: TextStyle(color: cs.onSurfaceVariant)),
                const SizedBox(height: 12),
                if (d['transcription'] != true)
                  Card(
                    color: cs.secondaryContainer,
                    child: ListTile(
                      leading: const Icon(Icons.mic_none),
                      title: const Text('To understand voice notes, add a free Groq key in Settings → AI service. Text and photos work without it.'),
                      onTap: () => openPath(context, '/settings#ai'),
                    ),
                  ),
                if ((shared != null && wa == null) || (wa?['config'] as Map?)?['mode'] == 'shared')
                  _SharedWhatsApp(ch: wa, number: '${shared?['number'] ?? (wa?['config'] as Map?)?['display_phone'] ?? ''}', reload: _load)
                else
                  _WhatsAppCard(ch: wa, reload: _load),
                if (shared != null && wa == null)
                  Card(child: ExpansionTile(title: const Text('Advanced: use my own WhatsApp Business number'), childrenPadding: const EdgeInsets.all(8), children: [_WhatsAppCard(ch: null, reload: _load)])),
                _TelegramCard(ch: tg, reload: _load),
                if (tg != null || wa != null) const _Background(),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('Privacy in chats', style: Theme.of(context).textTheme.titleSmall),
                      const SizedBox(height: 6),
                      Text('• Only chats you link with a one-time code are answered. In your private chat, only your own account is answered.\n'
                          '• In groups Carino answers only when mentioned or replied to, can add to-dos and reminders, look things up and find places — but can’t see your memories, tasks, notes or documents.\n'
                          '• Anything that needs approval shows Approve / Decline buttons in your private chat, and waits in Approvals.\n'
                          '• Send /stop in any chat to make Carino go quiet there, /start to bring it back.', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
                    ]),
                  ),
                ),
              ]),
            ),
    );
  }
}

Future<void> _run(BuildContext context, Future<void> Function() fn, [String? done]) async {
  try {
    await fn();
    if (context.mounted && done != null) toast(context, done);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e), error: true);
  }
}

class _Card extends StatelessWidget {
  final List<Widget> children;
  const _Card(this.children);
  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(padding: const EdgeInsets.all(14), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children)),
      );
}

class _Chats extends StatelessWidget {
  final Map ch;
  final Future<void> Function() reload;
  const _Chats({required this.ch, required this.reload});
  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final chats = ((ch['chats'] as List?) ?? const []).cast<Map>();
    return Column(children: [
      for (final c in chats)
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(c['is_group'] == true ? Icons.group_outlined : Icons.chat_bubble_outline),
          title: Text('${c['title'] ?? (c['is_group'] == true ? 'Group' : 'Private chat')}', maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text('${c['is_group'] == true ? 'group' : 'private'} · linked ${fmtDateTime('${c['created_at']}', time: false)}'),
          onTap: c['conversation_id'] != null ? () => openPath(context, '/chat/${c['conversation_id']}') : null,
          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
            Switch(value: c['muted'] != true, onChanged: (v) => _run(context, () async { await api.patch('/channel-chats/${c['id']}', {'muted': !v}); await reload(); })),
            IconButton(
              tooltip: 'Unlink',
              icon: const Icon(Icons.close),
              onPressed: () async {
                if (!await confirmDialog(context, title: 'Unlink ${c['title'] ?? 'this chat'}?', body: 'Carino stops answering there. Its conversation stays in Chat.', confirm: 'Unlink', danger: true)) return;
                if (context.mounted) await _run(context, () => api.delete('/channel-chats/${c['id']}'));
                await reload();
              },
            ),
          ]),
        ),
    ]);
  }
}

class _Pairing extends StatefulWidget {
  final Map ch;
  final String howTo;
  final Future<void> Function() reload;
  const _Pairing({required this.ch, required this.howTo, required this.reload});
  @override
  State<_Pairing> createState() => _PairingState();
}

class _PairingState extends State<_Pairing> {
  late String? _code = widget.ch['pairing_code'] as String?;
  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Card(
      color: cs.surfaceContainerHighest,
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(children: [
          const Icon(Icons.lock_outline, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: _code == null
                ? const Text('Link a chat or group with a one-time code.')
                : Text.rich(TextSpan(children: [
                    TextSpan(text: '${widget.howTo} '),
                    TextSpan(text: _code, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w800, fontSize: 17, letterSpacing: 2)),
                    const TextSpan(text: ' — valid for 15 minutes.'),
                  ])),
          ),
          TextButton(
            onPressed: () => _run(context, () async {
              final r = await AppState.read(context).api.post('/channels/${widget.ch['id']}/pair', {}) as Map;
              setState(() => _code = r['pairing_code'] as String?);
              await widget.reload();
            }),
            child: Text(_code != null ? 'New code' : 'Get a code'),
          ),
        ]),
      ),
    );
  }
}

class _ChannelHeader extends StatelessWidget {
  final Map ch;
  final String title;
  final String sub;
  final Future<void> Function() reload;
  const _ChannelHeader({required this.ch, required this.title, required this.sub, required this.reload});
  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final cs = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          Text(sub, style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
        ])),
        Switch(value: ch['enabled'] == true, onChanged: (v) => _run(context, () async { await api.patch('/channels/${ch['id']}', {'enabled': v}); await reload(); })),
      ]),
      if (ch['last_error'] != null) Text('${ch['last_error']}', style: TextStyle(fontSize: 13, color: cs.error)),
      Row(children: [
        Expanded(
          child: CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            dense: true,
            value: (ch['config'] as Map?)?['transcribe_voice'] != false,
            onChanged: (v) => _run(context, () async { await api.patch('/channels/${ch['id']}', {'transcribe_voice': v == true}); await reload(); }),
            title: const Text('Transcribe voice notes'),
          ),
        ),
        TextButton.icon(
          onPressed: () async {
            if (!await confirmDialog(context, title: 'Disconnect $title?', body: 'All linked chats are unlinked and the saved token is deleted.', confirm: 'Disconnect', danger: true)) return;
            if (context.mounted) await _run(context, () => api.delete('/channels/${ch['id']}'));
            await reload();
          },
          icon: const Icon(Icons.delete_outline, size: 16),
          label: const Text('Disconnect'),
        ),
      ]),
    ]);
  }
}

class _TelegramCard extends StatefulWidget {
  final Map? ch;
  final Future<void> Function() reload;
  const _TelegramCard({required this.ch, required this.reload});
  @override
  State<_TelegramCard> createState() => _TelegramCardState();
}

class _TelegramCardState extends State<_TelegramCard> {
  final _token = TextEditingController();
  bool _busy = false;
  @override
  Widget build(BuildContext context) {
    final ch = widget.ch;
    final api = AppState.read(context).api;
    if (ch != null) {
      final bot = '@${(ch['config'] as Map?)?['bot_username']}';
      return _Card([
        _ChannelHeader(ch: ch, title: 'Telegram', sub: 'Your bot: $bot${ch['last_seen_at'] != null ? ' · last message ${fmtDateTime('${ch['last_seen_at']}')}' : ''}', reload: widget.reload),
        _Pairing(ch: ch, reload: widget.reload, howTo: 'Open $bot in Telegram and send'),
        Padding(padding: const EdgeInsets.only(top: 6), child: Text('For a group: add $bot to the group, then send /link CODE there.', style: const TextStyle(fontSize: 12))),
        _Chats(ch: ch, reload: widget.reload),
      ]);
    }
    return _Card([
      Row(children: [Text('Telegram', style: Theme.of(context).textTheme.titleMedium), const SizedBox(width: 8), const Pill('free')]),
      const SizedBox(height: 6),
      const Text('1. In Telegram, open @BotFather and send /newbot. Pick a name (e.g. “Carino”) and a username ending in bot.\n'
          '2. BotFather replies with a token like 123456789:AAE…. Paste it here.\n'
          '3. Carino shows a 6-digit code — send it to your new bot. Done. No public web address is needed.', style: TextStyle(fontSize: 13)),
      TextButton.icon(onPressed: () => Device(api).openExternal('https://t.me/BotFather'), icon: const Icon(Icons.open_in_new, size: 16), label: const Text('Open @BotFather')),
      TextField(controller: _token, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Bot token from @BotFather')),
      const SizedBox(height: 10),
      FilledButton(
        onPressed: _busy || _token.text.trim().length < 20
            ? null
            : () async {
                setState(() => _busy = true);
                await _run(context, () async {
                  await api.post('/channels/telegram', {'token': _token.text.trim()});
                  await widget.reload();
                }, 'Telegram connected — now send the code to your bot');
                if (mounted) setState(() => _busy = false);
              },
        child: Text(_busy ? 'Connecting…' : 'Connect Telegram'),
      ),
    ]);
  }
}

class _Copyable extends StatelessWidget {
  final String label;
  final String value;
  const _Copyable(this.label, this.value);
  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        dense: true,
        title: Text(label),
        subtitle: SelectableText(value, style: const TextStyle(fontFamily: 'monospace')),
        trailing: IconButton(
          tooltip: 'Copy',
          icon: const Icon(Icons.copy, size: 18),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: value));
            if (context.mounted) toast(context, 'Copied');
          },
        ),
      );
}

class _WhatsAppCard extends StatefulWidget {
  final Map? ch;
  final Future<void> Function() reload;
  const _WhatsAppCard({required this.ch, required this.reload});
  @override
  State<_WhatsAppCard> createState() => _WhatsAppCardState();
}

class _WhatsAppCardState extends State<_WhatsAppCard> {
  final _phoneId = TextEditingController();
  final _access = TextEditingController();
  final _secret = TextEditingController();
  late final _relay = TextEditingController(text: '${(widget.ch?['config'] as Map?)?['relay_url'] ?? ''}');
  final _cf = TextEditingController();
  final _setup = TextEditingController();
  bool _verifyAtRelay = false;
  bool _busy = false;

  Future<void> _go(Future<void> Function() fn, String done) async {
    setState(() => _busy = true);
    await _run(context, () async {
      await fn();
      await widget.reload();
    }, done);
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final ch = widget.ch;
    final cfg = (ch?['config'] as Map?) ?? const {};
    final linked = cfg['relay_url'] != null && '${cfg['relay_url']}'.isNotEmpty;
    final api = AppState.read(context).api;
    final device = Device(api);
    final cs = Theme.of(context).colorScheme;
    Widget step(int n, bool done, String title, List<Widget> body) => Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            CircleAvatar(radius: 11, backgroundColor: done ? Colors.green : cs.primaryContainer, child: done ? const Icon(Icons.check, size: 14, color: Colors.white) : Text('$n', style: TextStyle(fontSize: 12, color: cs.onPrimaryContainer))),
            const SizedBox(width: 10),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: const TextStyle(fontWeight: FontWeight.w700)), ...body])),
          ]),
        );
    Widget link(String label, String url) => TextButton.icon(style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact), onPressed: () => device.openExternal(url), icon: const Icon(Icons.open_in_new, size: 14), label: Text(label));
    const small = TextStyle(fontSize: 13);
    return _Card([
      if (ch != null)
        _ChannelHeader(ch: ch, title: 'WhatsApp', sub: 'Carino’s number: ${cfg['display_phone'] ?? cfg['phone_number_id']}${ch['last_seen_at'] != null ? ' · last message ${fmtDateTime('${ch['last_seen_at']}')}' : ''}', reload: widget.reload)
      else ...[
        Row(children: [Text('WhatsApp', style: Theme.of(context).textTheme.titleMedium), const SizedBox(width: 8), const Pill('Beta')]),
        Text('Carino gets its own WhatsApp number that you chat with. It uses Meta’s official WhatsApp Business platform (free for chats you start) and a tiny free relay that holds messages until your phone collects them.', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
      ],
      step(1, ch != null, 'Your Meta app', [
        const Text('Create an app at Meta for Developers (or use the one from My apps → Facebook) and add WhatsApp. Under WhatsApp → API Setup, Meta gives you a free test number; add your own WhatsApp number as a recipient. Copy the Phone number ID; make a permanent access token in Business settings → System users (with whatsapp_business_messaging); and copy the App secret from App settings → Basic.', style: small),
        Wrap(spacing: 12, children: [link('Meta for Developers', 'https://developers.facebook.com/apps/creation/'), link('System users', 'https://business.facebook.com/settings/system-users')]),
        if (ch == null) ...[
          TextField(controller: _phoneId, keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Phone number ID')),
          TextField(controller: _access, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Access token')),
          TextField(controller: _secret, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'App secret')),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy || _phoneId.text.isEmpty || _access.text.isEmpty || _secret.text.isEmpty ? null : () => _go(() => api.post('/channels/whatsapp', {'phone_number_id': _phoneId.text.trim(), 'access_token': _access.text.trim(), 'app_secret': _secret.text.trim()}), 'WhatsApp connected — now set up the relay'),
            child: Text(_busy ? 'Connecting…' : 'Connect WhatsApp'),
          ),
        ],
      ]),
      step(2, linked, 'Your relay (free)', [
        const Text('Meta delivers messages to a web address that’s always on; the relay is that address, on your own Cloudflare account. Make a free Cloudflare account, then in API Tokens tap Create Token → Edit Cloudflare Workers → Use template → Continue → Create, and paste the token here. Carino sets the relay up and links it (the token isn’t kept).', style: small),
        Wrap(spacing: 12, children: [link('Cloudflare sign-up', 'https://dash.cloudflare.com/sign-up'), link('API Tokens', 'https://dash.cloudflare.com/profile/api-tokens')]),
        if (ch != null) ...[
          TextField(controller: _cf, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Cloudflare API token')),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _verifyAtRelay,
            onChanged: (v) => setState(() => _verifyAtRelay = v == true),
            title: const Text('Let the relay check Meta’s signature too', style: small),
            subtitle: const Text('Your app secret is then also kept on your own Cloudflare account. Off: the relay turns away anything not shaped like a WhatsApp delivery for your number, and limits how often one address can post.', style: TextStyle(fontSize: 12)),
          ),
          FilledButton(
            onPressed: _busy || _cf.text.trim().length < 20 ? null : () => _go(() async { await api.post('/channels/whatsapp/relay/create', {'token': _cf.text.trim(), 'verify_at_relay': _verifyAtRelay}); _cf.clear(); }, 'Relay created and linked'),
            child: Text(_busy ? 'Setting up…' : linked ? 'Create again' : 'Create my relay'),
          ),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('I already have a relay', style: small),
            children: [
              TextField(controller: _relay, keyboardType: TextInputType.url, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Relay address', hintText: 'https://…workers.dev')),
              TextField(controller: _setup, obscureText: true, decoration: const InputDecoration(labelText: 'Setup code (if set)')),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton(
                  onPressed: _busy || _relay.text.trim().length < 12 ? null : () => _go(() => api.post('/channels/whatsapp/relay', {'url': _relay.text.trim(), if (_setup.text.isNotEmpty) 'setup_code': _setup.text}), 'Relay linked'),
                  child: Text(linked ? 'Link again' : 'Link relay'),
                ),
              ),
              const Text('Deploying the relay yourself? Set a SETUP_CODE secret on it so nobody else can claim it first, and enter it here.', style: TextStyle(fontSize: 12)),
            ],
          ),
          if (linked) Text('Relay: ${cfg['relay_url']}', style: const TextStyle(fontSize: 12, fontFamily: 'monospace')),
        ],
      ]),
      step(3, ch?['last_seen_at'] != null, 'Tell Meta where to deliver', [
        const Text('In WhatsApp → Configuration → Webhook, tap Edit, paste these two values, Verify and save, then subscribe to messages.', style: small),
        if (linked && ch?['webhook_url'] != null) ...[_Copyable('Callback URL', '${ch!['webhook_url']}'), _Copyable('Verify token', '${cfg['verify_token']}')],
      ]),
      step(4, false, 'Say hello', [const Text('Get a code below and send it from your WhatsApp to Carino’s number.', style: small)]),
      if (ch != null && linked) _Pairing(ch: ch, reload: widget.reload, howTo: 'Send this from your WhatsApp to ${cfg['display_phone'] ?? 'Carino’s number'}:'),
      if (ch != null) _Chats(ch: ch, reload: widget.reload),
      const SizedBox(height: 8),
      Text('Replies to your messages are free. Meta only charges for messages a business starts after 24 hours of silence, which Carino doesn’t send. The relay only holds Meta’s deliveries until your phone collects them (at most 7 days); your app secret and replies never pass through it.', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
    ]);
  }
}

/// Carino's shared WhatsApp number: send a code from your WhatsApp and you're linked.
class _SharedWhatsApp extends StatefulWidget {
  final Map? ch;
  final String number;
  final Future<void> Function() reload;
  const _SharedWhatsApp({required this.ch, required this.number, required this.reload});
  @override
  State<_SharedWhatsApp> createState() => _SharedWhatsAppState();
}

class _SharedWhatsAppState extends State<_SharedWhatsApp> {
  Map? _link;
  bool _busy = false;
  Timer? _poll;

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    final api = AppState.read(context).api;
    setState(() => _busy = true);
    try {
      final l = await api.post('/channels/whatsapp/shared/link', {}) as Map;
      setState(() => _link = l);
      _poll?.cancel();
      // Wait for the code to arrive on WhatsApp.
      _poll = Timer.periodic(const Duration(seconds: 3), (t) async {
        final s = await api.get('/channels/whatsapp/shared/status').catchError((_) => null);
        if (s is Map && s['linked'] == true) {
          t.cancel();
          if (!mounted) return;
          setState(() => _link = null);
          toast(context, 'WhatsApp linked');
          await widget.reload();
        }
      });
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ch = widget.ch;
    final number = widget.number.isEmpty ? null : widget.number;
    final linked = ((ch?['chats'] as List?) ?? const []).isNotEmpty;
    if (ch != null && linked && _link == null) {
      return _Card([
        _ChannelHeader(ch: ch, title: 'WhatsApp', sub: 'Chat with Carino on ${number ?? 'its WhatsApp number'}${ch['last_seen_at'] != null ? ' · last message ${fmtDateTime('${ch['last_seen_at']}')}' : ''}', reload: widget.reload),
        _Chats(ch: ch, reload: widget.reload),
        TextButton.icon(onPressed: _busy ? null : _start, icon: const Icon(Icons.refresh, size: 16), label: const Text('Link a different WhatsApp')),
      ]);
    }
    final l = _link;
    return _Card([
      Text('WhatsApp', style: Theme.of(context).textTheme.titleMedium),
      const SizedBox(height: 4),
      Text('Chat with Carino on WhatsApp like with a friend: text, voice notes and photos. Carino has its own number${number != null ? ' ($number)' : ''}; link yours with a code.', style: const TextStyle(fontSize: 13)),
      const SizedBox(height: 10),
      if (l == null)
        FilledButton.icon(onPressed: _busy ? null : _start, icon: const Icon(Icons.send, size: 16), label: Text(_busy ? 'Getting a code…' : 'Link my WhatsApp'))
      else
        Card(
          color: Theme.of(context).colorScheme.primaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text.rich(TextSpan(children: [
                const TextSpan(text: 'Send '),
                TextSpan(text: '${l['code']}', style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w800, fontSize: 18, letterSpacing: 2)),
                const TextSpan(text: ' to '),
                TextSpan(text: '${l['number']}', style: const TextStyle(fontWeight: FontWeight.w700)),
                const TextSpan(text: ' on WhatsApp.'),
              ])),
              const Text('Waiting for it… (valid for 15 minutes)', style: TextStyle(fontSize: 12)),
              if (l['link'] != null) Padding(padding: const EdgeInsets.only(top: 8), child: FilledButton(onPressed: () => Device(AppState.read(context).api).openExternal('${l['link']}'), child: const Text('Open WhatsApp'))),
            ]),
          ),
        ),
    ]);
  }
}

/// Keeps answering while Carino is in the background (Android shows a quiet ongoing notification).
class _Background extends StatefulWidget {
  const _Background();
  @override
  State<_Background> createState() => _BackgroundState();
}

class _BackgroundState extends State<_Background> {
  Map? _state;
  @override
  void initState() {
    super.initState();
    AppState.read(context).api.get('/device/listen').then((s) { if (mounted) setState(() => _state = s as Map); }).catchError((_) {});
  }

  @override
  Widget build(BuildContext context) {
    final s = _state;
    if (s?['native'] != true) return const SizedBox.shrink();
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: SwitchListTile(
        value: s!['on'] == true,
        onChanged: (v) => _run(context, () async {
          final r = await AppState.read(context).api.put('/device/listen', {'on': v}) as Map;
          if (mounted) setState(() => _state = r);
        }),
        title: const Text('Answer in the background'),
        subtitle: const Text('Carino keeps answering WhatsApp and Telegram while you use other apps, with a quiet “Carino is listening” notification. If you swipe Carino away, messages wait until you open it again.'),
      ),
    );
  }
}
