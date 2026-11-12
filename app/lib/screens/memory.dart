import 'dart:async';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

const memoryCategories = {
  'profile': 'Profile', 'preference': 'Preferences', 'goal': 'Goals', 'routine': 'Routines', 'project': 'Plans',
  'date': 'Important dates', 'fact': 'Facts', 'summary': 'Conversation summaries',
};

/// What Carino remembers: view, search, edit, approve, delete; personal and work kept apart.
class MemoryScreen extends StatefulWidget {
  final String initialStatus;
  const MemoryScreen({super.key, this.initialStatus = 'active'});
  @override
  State<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends State<MemoryScreen> {
  late String _status = widget.initialStatus;
  String _category = '';
  String _context = '';
  String _q = '';
  Timer? _debounce;
  final _picked = <String>{};
  int _bump = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  String get _query {
    final p = {'status': _status, if (_category.isNotEmpty) 'category': _category, if (_context.isNotEmpty) 'context': _context, if (_q.isNotEmpty) 'q': _q};
    return Uri(queryParameters: p).query;
  }

  void _reload() => setState(() => _bump++);

  Future<void> _deletePicked() async {
    if (!await confirmDialog(context, title: tr('Delete {0} {1}?', [_picked.length, _picked.length == 1 ? 'memory' : 'memories']), body: tr('Carino will no longer know these things. This cannot be undone.'), confirm: tr('Delete'), danger: true)) return;
    if (!mounted) return;
    try {
      final r = await AppState.read(context).api.post('/memories/delete', {'ids': _picked.toList()}) as Map;
      if (mounted) toast(context, tr('Deleted {0}', [r['deleted']]));
      _picked.clear();
      _reload();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  Future<void> _clearAll() async {
    final label = memoryCategories[_category];
    if (!await confirmDialog(context, title: label != null ? 'Delete all “$label” memories?' : 'Delete ALL memories?', body: tr('This permanently removes them. This cannot be undone.'), confirm: tr('Delete permanently'), danger: true)) return;
    if (!mounted) return;
    try {
      final r = await AppState.read(context).api.post('/memories/clear', {if (_category.isNotEmpty) 'categories': [_category], 'confirm': true}) as Map;
      if (mounted) toast(context, tr('Deleted {0} memories', [r['deleted']]));
      _reload();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final memOff = (app.settings['memory'] as Map?)?['enabled'] == false;
    return Scaffold(
      appBar: AppBar(title: const Tx('Memory'), actions: [
        if (_picked.isNotEmpty) IconButton(tooltip: tr('Delete {0} selected', [_picked.length]), icon: const Icon(Icons.delete_outline), onPressed: _deletePicked),
        PopupMenuButton<String>(
          onSelected: (v) => v == 'clear' ? _clearAll() : null,
          itemBuilder: (_) => [PopupMenuItem(value: 'clear', child: Text(_category.isEmpty ? 'Clear all' : 'Clear this category'))],
        ),
      ]),
      floatingActionButton: FloatingActionButton.extended(onPressed: () => _edit(context, const {}), icon: const Icon(Icons.add), label: const Tx('Add memory')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 96), children: [
        Tx('Only approved memories are used. You can view, edit or delete any of them.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        if (memOff)
          Card(
            margin: const EdgeInsets.only(top: 10),
            color: Colors.orange.withValues(alpha: 0.1),
            child: ListTile(leading: const Icon(Icons.info_outline), title: const Tx('Memory is turned off'), subtitle: const Tx('Carino won’t use or save memories.'), onTap: () => openPath(context, '/settings#memory')),
          ),
        const SizedBox(height: 10),
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'active', label: Tx('Saved')), ButtonSegment(value: 'proposed', label: Tx('Waiting for OK'))],
          selected: {_status},
          onSelectionChanged: (s) => setState(() { _status = s.first; _picked.clear(); }),
        ),
        const SizedBox(height: 10),
        TextField(
          decoration: InputDecoration(hintText: tr('Search memories'), prefixIcon: Icon(Icons.search), isDense: true),
          onChanged: (v) {
            _debounce?.cancel();
            _debounce = Timer(const Duration(milliseconds: 300), () => setState(() => _q = v.trim()));
          },
        ),
        const SizedBox(height: 8),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final (v, l) in const [('', 'Personal and work'), ('personal', 'Personal'), ('work', 'Work')])
            ChoiceChip(label: Tx(l), selected: _context == v, onSelected: (_) => setState(() { _context = v; _picked.clear(); })),
          DropdownButton<String>(
            value: _category,
            underline: const SizedBox(),
            items: [const DropdownMenuItem(value: '', child: Tx('All categories')), for (final e in memoryCategories.entries) DropdownMenuItem(value: e.key, child: Tx(e.value))],
            onChanged: (v) => setState(() => _category = v ?? ''),
          ),
        ]),
        if (_status == 'proposed')
          Padding(padding: const EdgeInsets.only(top: 8), child: Tx('Carino suggested these but needs your OK — they may be sensitive or inferred.', style: Theme.of(context).textTheme.bodySmall)),
        const SizedBox(height: 8),
        Loader<List>(
          reloadKey: '$_bump|$_query',
          load: () async => ((await app.api.get('/memories?$_query')) as Map)['memories'] as List,
          builder: (context, list, reload) {
            if (list.isEmpty) return EmptyView(icon: Icons.psychology_outlined, title: _status == 'proposed' ? 'Nothing waiting for approval' : 'No memories yet', body: tr('Tell Carino “remember that…” in a chat, or add one here.'));
            return Card(
              child: Column(children: [
                for (final m in list.cast<Map>()) _MemoryTile(m: m, picked: _picked.contains(m['id']), onPick: (v) => setState(() => v ? _picked.add('${m['id']}') : _picked.remove(m['id'])), onEdit: () => _edit(context, m), changed: _reload),
              ]),
            );
          },
        ),
      ]),
    );
  }

  Future<void> _edit(BuildContext context, Map memory) async {
    final saved = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, useSafeArea: true, builder: (_) => MemoryForm(memory: memory));
    if (saved == true) _reload();
  }
}

class _MemoryTile extends StatelessWidget {
  final Map m;
  final bool picked;
  final ValueChanged<bool> onPick;
  final VoidCallback onEdit;
  final VoidCallback changed;
  const _MemoryTile({required this.m, required this.picked, required this.onPick, required this.onEdit, required this.changed});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final source = m['source'] == 'assistant' ? 'Suggested by Carino' : m['source'] == 'conversation_summary' ? 'From a conversation' : 'Added by you';
    return ListTile(
      leading: Checkbox(value: picked, onChanged: (v) => onPick(v == true)),
      title: Text('${m['content']}'),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Pill(memoryCategories[m['category']] ?? '${m['category']}', color: cs.outline),
          if (m['context'] == 'work') const Pill('work', color: Colors.indigo),
          if (m['local_only'] == 1 || m['local_only'] == true) const Pill('on your devices only', color: Colors.green),
          if (m['sensitive'] == true || m['sensitive'] == 1) const Pill('sensitive', color: Colors.orange),
          Text('$source · ${fmtDateTime(m['created_at'] as String?, time: false, year: true)}', style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
      trailing: m['status'] == 'proposed'
          ? FilledButton.tonal(
              onPressed: () async {
                await AppState.read(context).api.post('/memories/${m['id']}/approve');
                if (context.mounted) toast(context, tr('Memory saved'));
                changed();
              },
              child: const Tx('Approve'),
            )
          : PopupMenuButton<String>(
              onSelected: (v) async {
                if (v == 'edit') return onEdit();
                if (!await confirmDialog(context, title: tr('Forget this?'), body: '${m['content']}', confirm: tr('Delete'), danger: true)) return;
                if (!context.mounted) return;
                await AppState.read(context).api.delete('/memories/${m['id']}');
                changed();
              },
              itemBuilder: (_) => const [PopupMenuItem(value: 'edit', child: Tx('Edit')), PopupMenuItem(value: 'delete', child: Tx('Delete'))],
            ),
      onTap: onEdit,
    );
  }
}

/// Add or edit a memory.
class MemoryForm extends StatefulWidget {
  final Map memory;
  const MemoryForm({super.key, required this.memory});
  @override
  State<MemoryForm> createState() => _MemoryFormState();
}

class _MemoryFormState extends State<MemoryForm> {
  late final _content = TextEditingController(text: '${widget.memory['content'] ?? ''}');
  late String _category = '${widget.memory['category'] ?? 'fact'}';
  late String _ctx = '${widget.memory['context'] ?? 'personal'}';
  late DateTime? _expires = DateTime.tryParse('${widget.memory['expires_at'] ?? ''}');
  late bool _localOnly = widget.memory['local_only'] == 1 || widget.memory['local_only'] == true;
  bool _saving = false;

  Future<void> _save() async {
    setState(() => _saving = true);
    final api = AppState.read(context).api;
    final body = {
      'content': _content.text.trim(), 'category': _category, 'context': _ctx,
      'expires_at': _expires == null ? null : DateTime.utc(_expires!.year, _expires!.month, _expires!.day, 23, 59).toIso8601String(),
    };
    try {
      final id = widget.memory['id'];
      if (id != null) {
        await api.patch('/memories/$id', {...body, 'local_only': _localOnly});
      } else {
        final made = await api.post('/memories', body) as Map;
        final newId = made['id'] ?? (made['memory'] as Map?)?['id'];
        if (_localOnly && newId != null) await api.patch('/memories/$newId', {'local_only': true});
      }
      if (mounted) {
        toast(context, tr('Memory saved'));
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(widget.memory['id'] == null ? 'Add a memory' : 'Edit memory', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        TextField(controller: _content, onChanged: (_) => setState(() {}), minLines: 2, maxLines: 5, decoration: InputDecoration(labelText: tr('What should Carino remember?'), hintText: tr('e.g. I prefer a morning briefing at 7:00'))),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: DropdownButtonFormField<String>(initialValue: _category, decoration: InputDecoration(labelText: tr('Category')), items: [for (final e in memoryCategories.entries) DropdownMenuItem(value: e.key, child: Text(e.value))], onChanged: (v) => setState(() => _category = v ?? 'fact'))),
          const SizedBox(width: 10),
          Expanded(child: DropdownButtonFormField<String>(initialValue: _ctx, decoration: InputDecoration(labelText: tr('Part of')), items: const [DropdownMenuItem(value: 'personal', child: Tx('Personal life')), DropdownMenuItem(value: 'work', child: Tx('Work or business'))], onChanged: (v) => setState(() => _ctx = v ?? 'personal'))),
        ]),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Tx('Forget after (optional)'),
          subtitle: Text(_expires == null ? 'Keep until deleted' : fmtDateTime(_expires!.toIso8601String(), time: false, year: true)),
          trailing: _expires == null ? const Icon(Icons.event) : IconButton(icon: const Icon(Icons.close), onPressed: () => setState(() => _expires = null)),
          onTap: () async {
            final d = await showDatePicker(context: context, firstDate: DateTime.now(), lastDate: DateTime.now().add(const Duration(days: 3650)), initialDate: _expires ?? DateTime.now().add(const Duration(days: 30)));
            if (d != null) setState(() => _expires = d);
          },
        ),
        SwitchListTile(contentPadding: EdgeInsets.zero, value: _localOnly, onChanged: (v) => setState(() => _localOnly = v), title: const Tx('Keep on my devices only'), subtitle: const Tx('Never shown to an online AI')),
        const SizedBox(height: 8),
        FilledButton(onPressed: _saving || _content.text.trim().length < 2 ? null : _save, child: Text(_saving ? 'Saving…' : 'Save')),
      ]),
    );
  }
}
