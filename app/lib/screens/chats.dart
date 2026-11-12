import 'dart:async';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import 'chat.dart';

/// All chats, newest first, with search.
class ChatsScreen extends StatefulWidget {
  const ChatsScreen({super.key});
  @override
  State<ChatsScreen> createState() => _ChatsScreenState();
}

class _ChatsScreenState extends State<ChatsScreen> {
  String _q = '';
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Chats')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => ChatScreen.startNew(context),
        icon: const Icon(Icons.add),
        label: const Text('New chat'),
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: TextField(
            decoration: const InputDecoration(hintText: 'Search chats', prefixIcon: Icon(Icons.search), isDense: true),
            onChanged: (v) {
              _debounce?.cancel();
              _debounce = Timer(const Duration(milliseconds: 300), () => setState(() => _q = v.trim()));
            },
          ),
        ),
        Expanded(
          child: Loader<List>(
            reloadKey: '${app.revision}|$_q',
            load: () async => ((await app.api.get('/conversations${_q.isEmpty ? '' : '?q=${Uri.encodeQueryComponent(_q)}'}')) as Map)['conversations'] as List,
            builder: (context, list, reload) {
              if (list.isEmpty) {
                return Center(child: Text(_q.isEmpty ? 'No chats yet. Start one!' : 'No chats match “$_q”.'));
              }
              return RefreshIndicator(
                onRefresh: reload,
                child: ListView.separated(
                  padding: const EdgeInsets.only(bottom: 88),
                  itemCount: list.length,
                  separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
                  itemBuilder: (context, i) {
                    final c = list[i] as Map;
                    return ListTile(
                      title: Text('${c['title']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(_plain('${c['preview'] ?? ''}'), maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: Text(relativeTime(c['updated_at'] as String?), style: Theme.of(context).textTheme.bodySmall),
                      onTap: () async {
                        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(conversationId: c['id'] as String)));
                        reload();
                      },
                      onLongPress: () => _delete(context, c, reload),
                    );
                  },
                ),
              );
            },
          ),
        ),
      ]),
    );
  }

  Future<void> _delete(BuildContext context, Map c, Future<void> Function() reload) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this chat?'),
        content: Text('“${c['title']}” and its messages will be deleted.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Delete')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    try {
      await AppState.read(context).api.delete('/conversations/${c['id']}');
      await reload();
    } catch (e) {
      if (context.mounted) toast(context, errorText(e), error: true);
    }
  }
}

String _plain(String md) => md.replaceAll(RegExp(r'[*_`#>]'), '').replaceAll(RegExp(r'\s+'), ' ').trim();
