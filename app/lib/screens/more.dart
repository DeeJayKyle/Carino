import 'package:flutter/material.dart';

import '../app_state.dart';
import 'web_screen.dart';

/// Everything else in Carino. These open Carino's own screens until each is rebuilt in Flutter.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  static const groups = <(String, List<(IconData, String, String)>)>[
    ('Your stuff', [
      (Icons.account_balance_wallet_outlined, 'Money', '/money'),
      (Icons.work_outline, 'Applications', '/applications'),
      (Icons.folder_outlined, 'Files', '/files'),
      (Icons.sticky_note_2_outlined, 'Notes and documents', '/stuff'),
      (Icons.psychology_outlined, 'Memory', '/memory'),
      (Icons.repeat, 'Routines', '/routines'),
      (Icons.mic_none, 'Ramble it out', '/ramble'),
      (Icons.explore_outlined, 'Discover ideas', '/discover'),
    ]),
    ('You', [
      (Icons.pan_tool_outlined, 'Approvals', '/actions'),
      (Icons.notifications_none, 'Notifications', '/notifications'),
      (Icons.send_outlined, 'Messaging (WhatsApp, Telegram)', '/messaging'),
      (Icons.link, 'My apps', '/apps'),
      (Icons.auto_awesome_outlined, 'AI & connections', '/connections'),
      (Icons.settings_outlined, 'Settings', '/settings'),
    ]),
  ];

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('More')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        if (app.name.isNotEmpty)
          Card(
            child: ListTile(
              leading: CircleAvatar(child: Text(app.name.characters.first.toUpperCase())),
              title: Text(app.name, style: t.titleMedium),
              subtitle: Text('Assistant: ${app.assistantName}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => WebScreen.open(context, '/settings'),
            ),
          ),
        for (final (title, items) in groups) ...[
          Padding(padding: const EdgeInsets.fromLTRB(4, 18, 4, 6), child: Text(title, style: t.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary))),
          Card(
            child: Column(children: [
              for (final (icon, label, path) in items)
                ListTile(leading: Icon(icon), title: Text(label), trailing: const Icon(Icons.chevron_right), onTap: () => WebScreen.open(context, path)),
            ]),
          ),
        ],
      ]),
    );
  }
}
