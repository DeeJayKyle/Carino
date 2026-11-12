import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

String _bytes(num? n) {
  final b = (n ?? 0).toDouble();
  if (b < 1024) return '${b.round()} B';
  if (b < 1024 * 1024) return '${(b / 1024).toStringAsFixed(0)} KB';
  if (b < 1024 * 1024 * 1024) return '${(b / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(b / 1024 / 1024 / 1024).toStringAsFixed(1)} GB';
}

/// Folders on this device the user chose to let Carino read: search, duplicates, tidy-up ideas.
/// Changes are optional per folder, always previewed and approved, and undoable.
class FilesScreen extends StatefulWidget {
  const FilesScreen({super.key});
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  int _bump = 0;
  String _busy = '';

  Future<void> _run(String key, Future<dynamic> Function() fn, [String Function(dynamic)? ok]) async {
    setState(() => _busy = key);
    try {
      final r = await fn();
      if (mounted && ok != null) toast(context, ok(r));
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() { _busy = ''; _bump++; });
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final device = Device(app.api);
    return Loader<Map>(
      reloadKey: _bump,
      load: () async => await app.api.get('/files') as Map,
      builder: (context, data, _) {
        final folders = (data['folders'] as List? ?? const []).cast<Map>();
        final has = folders.isNotEmpty;
        return DefaultTabController(
          length: 4,
          child: Scaffold(
            appBar: AppBar(
              title: const Tx('Files'),
              bottom: has ? const TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [Tab(text: 'Search'), Tab(text: 'Duplicates'), Tab(text: 'Tidy up'), Tab(text: 'History')]) : null,
            ),
            body: data['available'] == false
                ? EmptyView(icon: Icons.folder_outlined, title: tr('Not on this device'), body: tr('Folders can be shared from Carino for Windows and the Android app.'))
                : NestedScrollView(
                    headerSliverBuilder: (context, _) => [
                      SliverToBoxAdapter(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                          child: Section(
                            title: tr('Folders Carino may read'),
                            action: FilledButton.tonalIcon(
                              onPressed: _busy.isNotEmpty
                                  ? null
                                  : () async {
                                      final picked = await device.pickFolder();
                                      if (picked == null) return;
                                      await _run('add', () => app.api.post('/files/folders', picked), (r) => 'Added ${picked['label']}: ${(r as Map)['scan']?['files'] ?? 0} files');
                                    },
                              icon: const Icon(Icons.add),
                              label: Text(_busy == 'add' ? 'Reading…' : 'Add a folder'),
                            ),
                            subtitle: tr('Carino can read only the folders you choose. Your files stay where they are.'),
                            child: !has
                                ? const Tx('None yet. Choose a folder in your phone’s own folder picker; you can remove it any time.')
                                : Column(children: [for (final f in folders) _folder(context, f, device)]),
                          ),
                        ),
                      ),
                    ],
                    body: has ? const TabBarView(children: [_Search(), _Duplicates(), _Tidy(), _History()]) : const SizedBox(),
                  ),
          ),
        );
      },
    );
  }

  Widget _folder(BuildContext context, Map f, Device device) {
    final api = AppState.read(context).api;
    final t = Theme.of(context).textTheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.folder_outlined),
        title: Text('${f['label']}', style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('${f['files']} file${f['files'] == 1 ? '' : 's'}${f['last_scan_at'] != null ? ' · checked ${fmtDateTime(f['last_scan_at'] as String?)}' : ''}${f['last_error'] != null ? ' · ${f['last_error']}' : ''}'),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          IconButton(tooltip: tr('Check again'), icon: _busy == 'scan-${f['id']}' ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.refresh), onPressed: () => _run('scan-${f['id']}', () => api.post('/files/folders/${f['id']}/scan', {}), (r) => '${(r as Map)['files']} files, ${r['read']} new or changed')),
          IconButton(
            tooltip: tr('Remove {0}', [f['label']]),
            icon: const Icon(Icons.close),
            onPressed: () async {
              if (!await confirmDialog(context, title: tr('Remove {0}?', [f['label']]), body: tr('Carino stops reading it and forgets what it noted. Your files aren’t touched.'), confirm: tr('Remove'))) return;
              await _run('rm', () => api.delete('/files/folders/${f['id']}'), (_) => 'Removed');
              await device.forgetFolder('${f['root']}');
            },
          ),
        ]),
      ),
      SwitchListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        value: f['can_change'] == true,
        onChanged: (v) => _run('perm', () => api.patch('/files/folders/${f['id']}', {'can_change': v}), (_) => v ? 'Changes allowed — each one still asks you first' : 'Read only'),
        title: const Tx('Allow changes (each one asks first)'),
      ),
      SwitchListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        value: f['local_only'] == true,
        onChanged: (v) => _run('lo', () => api.patch('/files/folders/${f['id']}', {'local_only': v}), (_) => v ? 'Only AI on your devices may read this folder' : 'Online AI may read files you ask about'),
        title: const Tx('Keep on my devices only'),
        subtitle: Tx('Only local AI reads it', style: t.bodySmall),
      ),
      const Divider(),
    ]);
  }
}

class _Search extends StatefulWidget {
  const _Search();
  @override
  State<_Search> createState() => _SearchState();
}

class _SearchState extends State<_Search> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return ListView(padding: const EdgeInsets.all(16), children: [
      TextField(
        textInputAction: TextInputAction.search,
        onSubmitted: (v) => setState(() => _q = v.trim()),
        decoration: InputDecoration(hintText: tr('Search inside your files… e.g. “insurance”'), prefixIcon: Icon(Icons.search)),
      ),
      if (_q.length >= 2)
        Loader<List>(
          reloadKey: _q,
          load: () async => ((await app.api.get('/files/search?q=${Uri.encodeQueryComponent(_q)}')) as Map)['results'] as List,
          builder: (context, results, _) => results.isEmpty
              ? const Padding(padding: EdgeInsets.all(16), child: Tx('Nothing found.'))
              : Column(children: [
                  for (final f in results.cast<Map>())
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.description_outlined),
                      title: Text('${f['name']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text('${f['folder']}/${f['rel_path']} · ${_bytes(f['size'] as num?)}', style: const TextStyle(fontSize: 12)),
                        if (f['snippet'] != null) Highlighted('${f['snippet']}'),
                      ]),
                      trailing: TextButton(
                        onPressed: () => openPath(context, '/chat/new?q=${Uri.encodeQueryComponent('Summarise the file "${f['name']}" from my folder ${f['folder']} (file id ${f['id']}).')}'),
                        child: const Tx('Summarise'),
                      ),
                    ),
                ]),
        ),
      const SizedBox(height: 8),
      Tx('Searching happens on this device. “Summarise” sends that file’s text to your AI service — except from folders kept on your devices, which only local AI reads.', style: Theme.of(context).textTheme.bodySmall),
    ]);
  }
}

/// A search snippet with its matches ([like this]) highlighted. File text is shown as text only.
class Highlighted extends StatelessWidget {
  final String text;
  const Highlighted(this.text, {super.key});

  @override
  Widget build(BuildContext context) {
    final parts = <InlineSpan>[];
    final re = RegExp(r'\[([^\]]*)\]');
    var i = 0;
    for (final m in re.allMatches(text)) {
      if (m.start > i) parts.add(TextSpan(text: text.substring(i, m.start)));
      parts.add(TextSpan(text: m.group(1), style: TextStyle(backgroundColor: Colors.yellow.withValues(alpha: 0.5), fontWeight: FontWeight.w600)));
      i = m.end;
    }
    if (i < text.length) parts.add(TextSpan(text: text.substring(i)));
    return Text.rich(TextSpan(children: parts, style: DefaultTextStyle.of(context).style.copyWith(fontSize: 13)));
  }
}

class _Duplicates extends StatelessWidget {
  const _Duplicates();

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Loader<List>(
      load: () async => ((await app.api.get('/files/duplicates')) as Map)['groups'] as List,
      builder: (context, groups, _) => groups.isEmpty
          ? EmptyView(icon: Icons.check, title: tr('No duplicates found'))
          : ListView(padding: const EdgeInsets.all(16), children: [
              const Tx('The same content in more than one place. To remove extra copies, see Tidy up.'),
              for (final g in groups.cast<Map>())
                Card(
                  margin: const EdgeInsets.only(top: 10),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Tx('{0} copies · {1} each', args: [g['copies'], _bytes(g['size'] as num?)], style: const TextStyle(fontWeight: FontWeight.w600)),
                      for (final (i, f) in (g['files'] as List).cast<Map>().indexed) Text('${f['folder']}/${f['rel_path']}${i == 0 ? ' — kept' : ''}', style: const TextStyle(fontSize: 12.5)),
                    ]),
                  ),
                ),
            ]),
    );
  }
}

class _Tidy extends StatefulWidget {
  const _Tidy();
  @override
  State<_Tidy> createState() => _TidyState();
}

class _TidyState extends State<_Tidy> {
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Loader<List>(
      reloadKey: _bump,
      load: () async => ((await app.api.get('/files/suggestions')) as Map)['suggestions'] as List,
      builder: (context, list, _) => list.isEmpty
          ? EmptyView(icon: Icons.check, title: tr('Nothing to tidy'), body: tr('Ideas appear here when there are duplicates or loose files.'))
          : ListView(padding: const EdgeInsets.all(16), children: [
              for (final s in list.cast<Map>())
                Card(
                  margin: const EdgeInsets.only(bottom: 10),
                  child: ExpansionTile(
                    title: Text('${s['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text('${s['why']}'),
                    childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    expandedCrossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final o in (s['ops'] as List).cast<Map>())
                        Text(o['op'] == 'move' ? 'Move ${o['from']} → ${o['to']}' : 'Delete ${o['path']} (a copy is kept so it can be undone)', style: const TextStyle(fontSize: 12.5)),
                      const SizedBox(height: 8),
                      FilledButton(
                        onPressed: () async {
                          try {
                            final r = await app.api.post('/files/changes', {'ops': s['ops']}) as Map;
                            if (context.mounted) toast(context, r['status'] == 'pending_approval' ? 'Waiting for your OK in Approvals' : 'Done');
                            setState(() => _bump++);
                          } catch (e) {
                            if (context.mounted) toast(context, errorText(e), error: true);
                          }
                        },
                        child: Tx('Ask to do this ({0} change{1})', args: [(s['ops'] as List).length, (s['ops'] as List).length == 1 ? '' : 's']),
                      ),
                    ],
                  ),
                ),
              Tx('Nothing changes until you approve it in Approvals, and only in folders where you allowed changes.', style: Theme.of(context).textTheme.bodySmall),
            ]),
    );
  }
}

class _History extends StatefulWidget {
  const _History();
  @override
  State<_History> createState() => _HistoryState();
}

class _HistoryState extends State<_History> {
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Loader<List>(
      reloadKey: _bump,
      load: () async => ((await app.api.get('/files/history')) as Map)['history'] as List,
      builder: (context, list, _) => list.isEmpty
          ? EmptyView(icon: Icons.schedule, title: tr('No changes yet'))
          : ListView(children: [
              for (final h in list.cast<Map>())
                ListTile(
                  title: Text(h['op'] == 'move' ? 'Moved ${h['from_rel']} → ${h['to_rel']}' : 'Deleted ${h['from_rel']}', maxLines: 2, overflow: TextOverflow.ellipsis),
                  subtitle: Text('${h['folder']} · ${fmtDateTime(h['created_at'] as String?)}${h['status'] == 'undone' ? ' · undone' : ''}'),
                  trailing: h['status'] == 'done'
                      ? TextButton(
                          onPressed: () async {
                            try {
                              await app.api.post('/files/history/${h['id']}/undo', {});
                              if (context.mounted) toast(context, tr('Undone'));
                              setState(() => _bump++);
                            } catch (e) {
                              if (context.mounted) toast(context, errorText(e), error: true);
                            }
                          },
                          child: const Tx('Undo'),
                        )
                      : null,
                ),
            ]),
    );
  }
}
