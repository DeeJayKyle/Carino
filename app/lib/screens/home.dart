import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import 'chat.dart';

/// Home: a greeting, ask anything, today at a glance, and recent chats.
class HomeScreen extends StatelessWidget {
  final void Function(int tab) onTab;
  const HomeScreen({super.key, required this.onTab});

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      body: SafeArea(
        child: Loader<Map<String, dynamic>>(
          reloadKey: app.revision,
          load: () async => await app.api.get('/dashboard') as Map<String, dynamic>,
          builder: (context, d, reload) => RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
              _Greeting(name: app.name, hour: (d['hour'] as num?)?.toInt() ?? DateTime.now().hour),
              const SizedBox(height: 14),
              const AskBar(),
              const SizedBox(height: 12),
              _QuickStarts(onTab: onTab),
              const SizedBox(height: 16),
              _Highlights(d: d, onTab: onTab),
              if (_attention(d) > 0) ...[
                const SizedBox(height: 12),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.notifications_active_outlined),
                    title: Tx('{0} thing{1} need{2} your attention', args: [_attention(d), _attention(d) == 1 ? '' : 's', _attention(d) == 1 ? 's' : '']),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => openPath(context, _pending(d) > 0 ? '/actions' : '/notifications'),
                  ),
                ),
              ],
              _RecentChats(list: (d['recentConversations'] as List?) ?? const []),
            ]),
          ),
        ),
      ),
    );
  }

  static int _pending(Map<String, dynamic> d) => ((d['overview'] as Map?)?['pendingActions'] as num?)?.toInt() ?? 0;
  static int _attention(Map<String, dynamic> d) => ((d['notifications'] as List?)?.length ?? 0) + _pending(d);
}

class _Greeting extends StatelessWidget {
  final String name;
  final int hour;
  const _Greeting({required this.name, required this.hour});

  @override
  Widget build(BuildContext context) {
    final greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    final first = name.split(' ').first;
    final t = Theme.of(context).textTheme;
    final now = DateTime.now();
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(first.isEmpty ? greet : '$greet, $first', style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
      Text('${days[now.weekday - 1]} ${now.day} ${months[now.month - 1]}', style: t.bodyMedium?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
    ]);
  }
}

/// "Ask Carino anything": starts a chat with the question.
class AskBar extends StatefulWidget {
  const AskBar({super.key});
  @override
  State<AskBar> createState() => _AskBarState();
}

class _AskBarState extends State<AskBar> {
  final _text = TextEditingController();

  Future<void> _ask() async {
    final q = _text.text.trim();
    if (q.isEmpty) return;
    _text.clear();
    FocusScope.of(context).unfocus();
    await ChatScreen.startNew(context, firstMessage: q);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return TextField(
      controller: _text,
      textInputAction: TextInputAction.send,
      onSubmitted: (_) => _ask(),
      decoration: InputDecoration(
        hintText: tr('Ask {0} anything…', [app.assistantName]),
        prefixIcon: const Icon(Icons.auto_awesome_outlined),
        suffixIcon: IconButton(icon: const Icon(Icons.send_rounded), tooltip: tr('Send'), onPressed: _ask),
      ),
    );
  }
}

class _QuickStarts extends StatelessWidget {
  final void Function(int tab) onTab;
  const _QuickStarts({required this.onTab});

  @override
  Widget build(BuildContext context) {
    final chips = <(IconData, String, VoidCallback)>[
      (Icons.wb_sunny_outlined, 'My day', () => ChatScreen.startNew(context, firstMessage: 'What does my day look like? Help me plan it.')),
      (Icons.mic_none, 'Ramble it out', () => openPath(context, '/ramble')),
      (Icons.notifications_none, 'Remind me…', () => ChatScreen.startNew(context, draft: 'Remind me ')),
      (Icons.record_voice_over_outlined, 'Just talk', () => openPath(context, '/chat/new?voice=1')),
    ];
    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: chips.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) => ActionChip(avatar: Icon(chips[i].$1, size: 18), label: Text(chips[i].$2), onPressed: chips[i].$3),
      ),
    );
  }
}

class _Highlights extends StatelessWidget {
  final Map<String, dynamic> d;
  final void Function(int tab) onTab;
  const _Highlights({required this.d, required this.onTab});

  @override
  Widget build(BuildContext context) {
    final o = (d['overview'] as Map?) ?? const {};
    final due = (o['due'] as List?)?.length ?? 0;
    final overdue = (o['overdue'] as List?)?.length ?? 0;
    final reminders = (o['reminders'] as List?) ?? const [];
    final next = reminders.isEmpty ? null : reminders.first as Map;
    final cs = Theme.of(context).colorScheme;
    final cards = <Widget>[
      _Highlight(
        icon: Icons.checklist, color: overdue > 0 ? cs.error : cs.primary, kicker: 'Today',
        title: due + overdue == 0 ? 'Nothing due' : '$due due${overdue > 0 ? ' · $overdue overdue' : ''}',
        body: due + overdue == 0 ? 'A clear day. Add something?' : ((o['due'] as List?)?.isNotEmpty == true ? '${((o['due'] as List).first as Map)['title']}' : 'Catch up on overdue to-dos'),
        onTap: () => onTab(2),
      ),
      _Highlight(
        icon: Icons.wb_sunny_outlined, color: Colors.orange, kicker: 'Your briefing', title: tr('Here’s your day'),
        body: (d['briefing'] as String?) ?? '', onTap: () => ChatScreen.startNew(context, firstMessage: 'What does my day look like? Help me plan it.'),
      ),
      _Highlight(
        icon: next == null ? Icons.event_outlined : Icons.notifications_outlined, color: Colors.blue, kicker: 'Coming up',
        title: next == null ? 'No reminders today' : '${next['title'] ?? 'Reminder'}',
        body: next == null ? 'Ask me to remind you of anything.' : '${next['at'] ?? ''}', onTap: () => onTab(2),
      ),
    ];
    return SizedBox(
      height: 150,
      child: ListView.separated(scrollDirection: Axis.horizontal, itemCount: cards.length, separatorBuilder: (_, _) => const SizedBox(width: 10), itemBuilder: (_, i) => cards[i]),
    );
  }
}

class _Highlight extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String kicker, title, body;
  final VoidCallback onTap;
  const _Highlight({required this.icon, required this.color, required this.kicker, required this.title, required this.body, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SizedBox(
      width: 230,
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [Icon(icon, size: 16, color: color), const SizedBox(width: 6), Text(kicker, style: t.labelMedium?.copyWith(color: color))]),
              const SizedBox(height: 6),
              Text(title, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 4),
              Expanded(child: Text(body, style: t.bodySmall, maxLines: 4, overflow: TextOverflow.ellipsis)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _RecentChats extends StatelessWidget {
  final List list;
  const _RecentChats({required this.list});

  @override
  Widget build(BuildContext context) {
    if (list.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 18),
      Tx('Recent chats', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
      const SizedBox(height: 6),
      Card(
        child: Column(children: [
          for (final c in list.take(6))
            ListTile(
              leading: const Icon(Icons.chat_bubble_outline, size: 20),
              title: Text('${(c as Map)['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
              trailing: Text(relativeTime(c['updated_at'] as String?), style: Theme.of(context).textTheme.bodySmall),
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(conversationId: c['id'] as String))),
            ),
        ]),
      ),
    ]);
  }
}
