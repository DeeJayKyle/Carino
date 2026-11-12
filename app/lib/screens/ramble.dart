import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/dictation.dart';
import '../widgets/ui.dart';

const _typeLabel = {'task': 'To-do', 'reminder': 'Reminder', 'memory': 'Memory'};
const _typeIcon = {'task': Icons.check_box_outlined, 'reminder': Icons.notifications_none, 'memory': Icons.psychology_outlined};

/// Ramble it out: talk or type everything on your mind; Carino sorts it into to-dos, reminders and
/// memories, and you choose what to keep.
class RambleScreen extends StatefulWidget {
  const RambleScreen({super.key});
  @override
  State<RambleScreen> createState() => _RambleScreenState();
}

class _RambleScreenState extends State<RambleScreen> {
  final _text = TextEditingController();
  List<Map<String, dynamic>>? _items;
  String? _busy;
  Map? _done;
  Dictation? _voice;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_voice == null) {
      final app = AppState.read(context);
      final lang = '${(app.settings['voice'] as Map?)?['language'] ?? 'en-US'}';
      _voice = Dictation(engine: app.engine, device: Device(app.api), lang: lang, continuous: true, onFinal: (t) {
        _text.text = _text.text.isEmpty ? t : '${_text.text} $t';
      })
        ..addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _voice?.dispose();
    _text.dispose();
    super.dispose();
  }

  Future<void> _sort() async {
    final api = AppState.read(context).api;
    if (_voice!.listening) await _voice!.stop();
    setState(() => _busy = 'sort');
    try {
      final r = await api.post('/ramble/extract', {'text': _text.text}) as Map;
      setState(() {
        _items = [for (final i in (r['items'] as List).cast<Map>()) {...Map<String, dynamic>.from(i), 'keep': true}];
        _done = null;
      });
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _add() async {
    final kept = _items!.where((i) => i['keep'] == true).map((i) {
      final m = Map<String, dynamic>.from(i)..removeWhere((k, _) => const {'keep', 'warning', 'when_text', 'when_label'}.contains(k));
      return m;
    }).toList();
    setState(() => _busy = 'add');
    try {
      final r = await AppState.read(context).api.post('/ramble/apply', {'items': kept}) as Map;
      setState(() {
        _done = r;
        _items = null;
        _text.clear();
      });
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  String _doneText(Map d) {
    String n(num? c, String one, String many) => (c ?? 0) > 0 ? '$c ${c == 1 ? one : many}' : '';
    return 'Added ${[n(d['tasks'], 'task', 'tasks'), n(d['reminders'], 'reminder', 'reminders'), n(d['memories'], 'memory', 'memories')].where((s) => s.isNotEmpty).join(', ')}.';
  }

  Future<void> _pickWhen(int n) async {
    final i = _items![n];
    final cur = DateTime.tryParse('${i['when_iso'] ?? ''}')?.toLocal() ?? DateTime.now();
    final d = await showDatePicker(context: context, initialDate: cur, firstDate: DateTime.now().subtract(const Duration(days: 365)), lastDate: DateTime.now().add(const Duration(days: 3650)));
    if (d == null || !mounted) return;
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(cur));
    if (t == null) return;
    setState(() {
      i['when_iso'] = DateTime(d.year, d.month, d.day, t.hour, t.minute).toUtc().toIso8601String();
      i['all_day'] = false;
      i.remove('warning');
    });
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final voiceOn = (app.settings['voice'] as Map?)?['enabled'] != false;
    final v = _voice!;
    final items = _items;
    final kept = items?.where((i) => i['keep'] == true).length ?? 0;
    return Scaffold(
      appBar: AppBar(title: const Text('Ramble it out')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
        Text('Got a lot on your mind? Talk or type it all out, in any order. Carino sorts it into to-dos, reminders and things to remember, and you choose what to keep.', style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        const SizedBox(height: 12),
        if (_done != null)
          Card(
            child: ListTile(
              leading: const Icon(Icons.check_circle_outline),
              title: Text(_doneText(_done!)),
              trailing: TextButton(onPressed: () => openPath(context, '/tasks'), child: const Text('Open to-dos')),
            ),
          ),
        if (items == null) ...[
          TextField(
            controller: _text,
            minLines: 8,
            maxLines: 16,
            maxLength: 20000,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(hintText: 'e.g. I need to order paracetamol by Friday, remind me to call Mama tomorrow at 5, the shop sign is broken, and I had an idea for a loyalty card…', border: OutlineInputBorder()),
          ),
          if (v.interim.isNotEmpty) Text(v.interim, style: const TextStyle(fontStyle: FontStyle.italic)),
          Row(children: [
            if (voiceOn)
              OutlinedButton.icon(
                onPressed: v.listening ? v.stop : v.start,
                icon: Icon(v.listening ? Icons.stop : Icons.mic_none),
                label: Text(v.listening ? 'Stop talking' : 'Talk'),
              ),
            const Spacer(),
            FilledButton.icon(
              onPressed: _text.text.trim().isEmpty || _busy == 'sort' ? null : _sort,
              icon: const Icon(Icons.auto_awesome),
              label: Text(_busy == 'sort' ? 'Sorting…' : 'Sort it out'),
            ),
          ]),
          if (v.listening) const Padding(padding: EdgeInsets.only(top: 6), child: Text('Listening — take your time, pauses are fine.', style: TextStyle(fontSize: 12))),
          if (v.error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(v.error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
        ] else ...[
          if (items.isEmpty)
            EmptyView(icon: Icons.check, title: 'Nothing to add', body: 'Carino didn’t find any to-dos, reminders or things to remember in that.')
          else ...[
            const Text('Here’s what Carino picked out. Untick anything you don’t want, and check the dates before adding.'),
            const SizedBox(height: 8),
            for (final (n, i) in items.indexed)
              Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: Opacity(
                  opacity: i['keep'] == true ? 1 : 0.55,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(4, 8, 12, 10),
                    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Checkbox(value: i['keep'] == true, onChanged: (x) => setState(() => i['keep'] = x == true)),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          TextFormField(initialValue: '${i['title'] ?? ''}', maxLength: 300, decoration: const InputDecoration(labelText: 'Title', counterText: ''), onChanged: (t) => i['title'] = t),
                          if ((i['details'] as String?)?.isNotEmpty == true) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${i['details']}', style: const TextStyle(fontSize: 13))),
                          const SizedBox(height: 6),
                          Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
                            DropdownButton<String>(
                              value: '${i['type']}',
                              items: [for (final t in _typeLabel.keys) DropdownMenuItem(value: t, child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(_typeIcon[t], size: 16), const SizedBox(width: 6), Text(_typeLabel[t]!)]))],
                              onChanged: (t) => setState(() => i['type'] = t),
                            ),
                            if (i['type'] != 'memory')
                              ActionChip(
                                avatar: const Icon(Icons.event, size: 16),
                                label: Text(i['when_iso'] != null ? fmtDateTime('${i['when_iso']}') : 'Set a time'),
                                onPressed: () => _pickWhen(n),
                              ),
                            if (i['type'] != 'memory' && i['when_text'] != null) Text('from “${i['when_text']}”', style: const TextStyle(fontSize: 12)),
                            if (i['priority'] == 1) Pill('urgent', color: Theme.of(context).colorScheme.error),
                          ]),
                          if (i['warning'] != null && i['type'] != 'memory') Text('${i['warning']}', style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.tertiary)),
                        ]),
                      ),
                    ]),
                  ),
                ),
              ),
          ],
          const SizedBox(height: 8),
          Row(children: [
            OutlinedButton.icon(onPressed: () => setState(() => _items = null), icon: const Icon(Icons.edit_outlined), label: const Text('Back to my ramble')),
            const Spacer(),
            if (items.isNotEmpty)
              FilledButton.icon(onPressed: kept == 0 || _busy == 'add' ? null : _add, icon: const Icon(Icons.check), label: Text(_busy == 'add' ? 'Adding…' : 'Add $kept item${kept == 1 ? '' : 's'}')),
          ]),
        ],
      ]),
    );
  }
}
