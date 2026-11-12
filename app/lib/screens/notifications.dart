import 'dart:async';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Reminders, briefings, budget alerts and failed actions; marked read after a moment.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});
  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  int _bump = 0;
  Timer? _read;

  @override
  void dispose() {
    _read?.cancel();
    super.dispose();
  }

  static const _icons = {'reminder': Icons.notifications_none, 'budget': Icons.account_balance_wallet_outlined, 'action_failed': Icons.error_outline, 'routine': Icons.auto_awesome_outlined};

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Tx('Notifications'), actions: [
        IconButton(
          tooltip: tr('Clear all'),
          icon: const Icon(Icons.delete_sweep_outlined),
          onPressed: () async {
            if (!await confirmDialog(context, title: tr('Clear all notifications?'), body: tr('This permanently deletes every notification. Reminders and routines keep working.'), confirm: tr('Clear all'), danger: true)) return;
            await app.api.delete('/notifications');
            setState(() => _bump++);
          },
        ),
      ]),
      body: Loader<Map>(
        reloadKey: _bump,
        load: () async => await app.api.get('/notifications') as Map,
        builder: (context, d, reload) {
          final list = (d['notifications'] as List).cast<Map>();
          if ((d['unread'] as num? ?? 0) > 0) {
            _read?.cancel();
            _read = Timer(const Duration(milliseconds: 1500), () => app.api.post('/notifications/read', {}).catchError((_) => null));
          }
          if (list.isEmpty) return EmptyView(icon: Icons.notifications_none, title: tr('No notifications'), body: tr('Reminders, briefings and failed actions will appear here.'));
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView.separated(
              itemCount: list.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final n = list[i];
                final unread = n['read'] == 0 || n['read'] == false;
                return ListTile(
                  leading: Icon(_icons[n['kind']] ?? Icons.info_outline, color: n['kind'] == 'action_failed' ? Theme.of(context).colorScheme.error : Theme.of(context).colorScheme.primary),
                  title: Text('${n['title']}', style: TextStyle(fontWeight: unread ? FontWeight.w700 : FontWeight.w500)),
                  subtitle: Text([if ((n['body'] ?? '') != '') '${n['body']}', relativeTime(n['created_at'] as String?)].join('\n')),
                  isThreeLine: (n['body'] ?? '') != '',
                  trailing: unread ? const Pill('new') : null,
                  onTap: n['link'] == null ? null : () => openPath(context, '${n['link']}'),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
