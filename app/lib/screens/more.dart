import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

String _plural(num n, String one, [String? many]) => '$n ${n == 1 ? one : (many ?? '${one}s')}';

/// "Your stuff" and "You": everything Carino holds for you, and your own settings.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  static const you = <(IconData, String, String)>[
    (Icons.pan_tool_outlined, 'Approvals', '/actions'),
    (Icons.notifications_none, 'Notifications', '/notifications'),
    (Icons.send_outlined, 'Messaging (WhatsApp, Telegram)', '/messaging'),
    (Icons.link, 'My apps', '/apps'),
    (Icons.auto_awesome_outlined, 'AI & connections', '/connections'),
    (Icons.explore_outlined, 'Discover ideas', '/discover'),
    (Icons.settings_outlined, 'Settings', '/settings'),
  ];

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final t = Theme.of(context).textTheme;
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Tx('Your stuff')),
      body: Loader<Map>(
        reloadKey: app.revision,
        load: () async => await app.api.get('/stuff') as Map,
        builder: (context, d, reload) {
          final tasks = (d['tasks'] as Map?) ?? const {};
          final money = d['money'] as Map?;
          final apps = d['applications'] as Map?;
          final routines = (d['routines'] as Map?) ?? const {};
          final memories = (d['memories'] as Map?) ?? const {};
          final reminders = (d['reminders'] as Map?) ?? const {};
          final tiles = <(IconData, String, String, String, bool, String)>[
            (Icons.checklist, 'To-dos & reminders', _plural(tasks['open'] ?? 0, 'open to-do'),
              [if ((tasks['overdue'] ?? 0) > 0) '${tasks['overdue']} overdue', if ((tasks['dueToday'] ?? 0) > 0) '${tasks['dueToday']} due today'].join(' · ').ifEmpty('Nothing urgent'), (tasks['overdue'] ?? 0) > 0, '/tasks'),
            (Icons.account_balance_wallet_outlined, 'Money', (money?['spent'] ?? 0) > 0 ? '${money!['currency'] ?? ''} ${money['spent']} this month'.trim() : 'Nothing logged yet',
              (money?['over'] ?? 0) > 0 ? '${_plural(money!['over'], 'budget')} over' : 'Spending, income, bills and savings', (money?['over'] ?? 0) > 0, '/money'),
            (Icons.work_outline, 'Applications', (apps?['open'] ?? 0) > 0 ? _plural(apps!['open'], 'open application') : 'None yet',
              (apps?['dueSoon'] ?? 0) > 0 ? '${_plural(apps!['dueSoon'], 'deadline')} this week' : 'Jobs and scholarships', (apps?['dueSoon'] ?? 0) > 0, '/applications'),
            (Icons.folder_outlined, 'Files', (d['folders'] ?? 0) > 0 ? _plural(d['files'] ?? 0, 'file') : 'No folders yet', (d['folders'] ?? 0) > 0 ? 'In ${_plural(d['folders'], 'folder')} you chose' : 'Search documents on this device', false, '/files'),
            (Icons.repeat, 'Routines', '${_plural(routines['active'] ?? 0, 'routine')} on', (routines['custom'] ?? 0) > 0 ? '${routines['custom']} of your own' : 'Add your first one', false, '/routines'),
            (Icons.web_outlined, 'Pages & apps', 'Made in chat', 'Invites, menus, checklists and small apps', false, '/pages'),
            (Icons.psychology_outlined, 'What ${app.assistantName} remembers', _plural(memories['active'] ?? 0, 'memory', 'memories'),
              (memories['waiting'] ?? 0) > 0 ? '${memories['waiting']} waiting for your OK' : 'You’re in control of all of it', (memories['waiting'] ?? 0) > 0, '/memory'),
            (Icons.mic_none, 'Ramble it out', 'Talk, Carino sorts it', 'To-dos, reminders and notes from a brain-dump', false, '/ramble'),
          ];
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
              if ((d['approvals'] ?? 0) > 0)
                Card(
                  color: Colors.orange.withValues(alpha: 0.12),
                  child: ListTile(leading: const Icon(Icons.shield_outlined, color: Colors.orange), title: Tx('{0} waiting for your approval', args: [_plural(d['approvals'], 'action')]), trailing: const Icon(Icons.chevron_right), onTap: () => openPath(context, '/actions')),
                ),
              if (reminders['next'] is Map)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Tx('🔔 Next reminder: {0} · {1}', args: [(reminders['next'] as Map)['title'], fmtDateTime((reminders['next'] as Map)['remind_at'] as String?)], style: t.bodySmall),
                ),
              const SizedBox(height: 6),
              LayoutBuilder(builder: (context, c) {
                final cols = c.maxWidth > 700 ? 3 : 2;
                final w = (c.maxWidth - (cols - 1) * 10) / cols;
                return Wrap(spacing: 10, runSpacing: 10, children: [
                  for (final (icon, title, main, sub, warn, path) in tiles)
                    SizedBox(
                      width: w,
                      child: Card(
                        clipBehavior: Clip.antiAlias,
                        child: InkWell(
                          onTap: () => openPath(context, path),
                          child: Padding(
                            padding: const EdgeInsets.all(14),
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Icon(icon, color: cs.primary),
                              const SizedBox(height: 8),
                              Tx(title, style: t.labelLarge?.copyWith(color: cs.onSurfaceVariant)),
                              Text(main, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700), maxLines: 1, overflow: TextOverflow.ellipsis),
                              Text(sub, style: t.bodySmall?.copyWith(color: warn ? cs.error : cs.onSurfaceVariant), maxLines: 2, overflow: TextOverflow.ellipsis),
                            ]),
                          ),
                        ),
                      ),
                    ),
                ]);
              }),
              Padding(padding: const EdgeInsets.fromLTRB(4, 22, 4, 6), child: Tx('You', style: t.titleSmall?.copyWith(color: cs.primary))),
              Card(
                child: Column(children: [
                  if (app.name.isNotEmpty)
                    ListTile(
                      leading: CircleAvatar(child: Text(app.name.characters.first.toUpperCase())),
                      title: Text(app.name),
                      subtitle: Tx('Assistant: {0}', args: [app.assistantName]),
                      onTap: () => openPath(context, '/settings'),
                    ),
                  for (final (icon, label, path) in you) ListTile(leading: Icon(icon), title: Tx(label), trailing: const Icon(Icons.chevron_right), onTap: () => openPath(context, path)),
                  ListTile(
                    leading: const Icon(Icons.card_giftcard_outlined),
                    title: const Tx('Invite a friend'),
                    subtitle: const Tx('Share a link to download Carino'),
                    onTap: () => Device(app.api).shareText('I use Carino, a personal assistant that keeps things on my phone. Get it here: https://github.com/DeeJayKyle/Carino/releases/latest'),
                  ),
                  ListTile(
                    leading: const Icon(Icons.feedback_outlined),
                    title: const Tx('Send feedback'),
                    subtitle: const Tx('Report a problem or suggest something'),
                    onTap: () => _feedback(context),
                  ),
                ]),
              ),
            ]),
          );
        },
      ),
    );
  }
}

/// Feedback goes wherever the user sends it: written here, opened as a GitHub issue in their
/// browser for them to post (nothing is sent without them).
Future<void> _feedback(BuildContext context) async {
  final api = AppState.read(context).api;
  final c = TextEditingController();
  final text = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Tx('Send feedback'),
      content: TextField(controller: c, minLines: 4, maxLines: 10, decoration: InputDecoration(hintText: tr('What happened, or what would make Carino better? Please leave out private details.'))),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Tx('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Tx('Continue'))],
    ),
  );
  if (text == null || text.isEmpty) return;
  final info = await Device(api).info().catchError((_) => <String, dynamic>{});
  final body = '$text\n\n---\nCarino ${info['version'] ?? ''} (${info['flavor'] ?? ''})';
  final url = Uri.https('github.com', '/DeeJayKyle/Carino/issues/new', {'title': text.split('\n').first.characters.take(70).toString(), 'body': body});
  await Device(api).openExternal(url.toString());
}

extension on String {
  String ifEmpty(String other) => isEmpty ? other : this;
}
