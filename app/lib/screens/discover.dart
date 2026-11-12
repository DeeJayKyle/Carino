import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/icons.dart';

/// Ideas for what Carino can take off your plate; tapping one starts it.
class DiscoverScreen extends StatefulWidget {
  const DiscoverScreen({super.key});
  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

/// What a card does when tapped.
Future<void> openIdea(BuildContext context, Map card) {
  return switch (card['action']) {
    'chat' => openPath(context, '/chat/new?q=${Uri.encodeQueryComponent('${card['prompt']}')}'),
    'routine' => openPath(context, '/routines?idea=${Uri.encodeQueryComponent('${card['routine']}')}'),
    'ramble' => openPath(context, '/ramble'),
    'voice' => openPath(context, '/chat/new?voice=1'),
    _ => openPath(context, card['id'] == 'group' ? '/messaging' : '/apps'),
  };
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  String? _cat;
  static const _go = {'chat': 'Start', 'routine': 'Set up', 'ramble': 'Talk it out', 'voice': 'Talk', 'connect': 'Connect'};

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Tx('Discover')),
      body: Loader<List>(
        load: () async => ((await app.api.get('/discover')) as Map)['cards'] as List,
        builder: (context, cards, _) {
          final list = cards.cast<Map>();
          final forYou = list.any((c) => c['forYou'] == true);
          final cats = [if (forYou) 'For you', 'All', ...{for (final c in list) '${c['category']}'}];
          final active = cats.contains(_cat) ? _cat! : cats.first;
          final shown = list.where((c) => active == 'All' || (active == 'For you' ? c['forYou'] == true : c['category'] == active)).toList();
          return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
            Tx('What can {0} take off your plate?', args: [app.assistantName], style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Tx('Tap an idea to start. Nothing is sent, bought or deleted without your OK.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
            const SizedBox(height: 12),
            Wrap(spacing: 6, runSpacing: 6, children: [for (final c in cats) ChoiceChip(label: Text(c), selected: c == active, onSelected: (_) => setState(() => _cat = c))]),
            const SizedBox(height: 12),
            for (final c in shown)
              Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: ListTile(
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  leading: CircleAvatar(backgroundColor: Theme.of(context).colorScheme.primaryContainer, child: Icon(iconFor('${c['icon']}'), color: Theme.of(context).colorScheme.onPrimaryContainer)),
                  title: Text('${c['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${c['blurb']}'),
                  trailing: Text(_go[c['action']] ?? 'Open', style: TextStyle(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.w600)),
                  onTap: () => openIdea(context, c),
                ),
              ),
          ]);
        },
      ),
    );
  }
}
