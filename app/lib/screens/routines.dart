import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/icons.dart';
import '../widgets/ui.dart';

const _dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _order = [1, 2, 3, 4, 5, 6, 0];

/// Life goals a routine can belong to (same ids as the engine).
const goalLabels = {
  'career': 'Career', 'family': 'Family', 'money': 'Money', 'friends': 'Friends', 'kids': 'Kids',
  'health': 'Health', 'travel': 'Travel', 'home': 'Home', 'learning': 'Learning', 'other': 'Other',
};

String scheduleText(List days, String time) {
  final s = {...days.map((d) => (d as num).toInt())};
  final when = s.length == 7 ? 'Every day' : (s.length == 5 && !s.contains(0) && !s.contains(6)) ? 'Weekdays' : (s.length == 2 && s.contains(0) && s.contains(6)) ? 'Weekends' : _order.where(s.contains).map((d) => _dayNames[d]).join(', ');
  return '$when at $time';
}

const _builtIn = {
  'morning_briefing': 'Your day: to-dos, anything overdue and today’s reminders.',
  'evening_review': 'What you got done, what’s still open, and tomorrow’s priorities.',
};

/// Routines: things Carino does on a schedule, built-in ones and your own, with ideas to start from.
class RoutinesScreen extends StatefulWidget {
  final String? idea;
  const RoutinesScreen({super.key, this.idea});
  @override
  State<RoutinesScreen> createState() => _RoutinesScreenState();
}

class _RoutinesScreenState extends State<RoutinesScreen> {
  int _bump = 0;
  String? _running;
  String _cat = 'All';
  String? _goal;
  bool _ideaOpened = false;

  void _reload() => setState(() => _bump++);

  Future<void> _edit(Map<String, dynamic> draft) async {
    final saved = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, useSafeArea: true, builder: (_) => RoutineEditor(draft: draft));
    if (saved == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Routines')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit({'title': '', 'prompt': '', 'time_local': '08:00', 'days': [1, 2, 3, 4, 5]}),
        icon: const Icon(Icons.add),
        label: const Text('New routine'),
      ),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 96), children: [
        Text('Your routines', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Loader<List>(
          reloadKey: _bump,
          load: () async => ((await app.api.get('/routines')) as Map)['routines'] as List,
          builder: (context, list, _) {
            final goals = {for (final r in list.cast<Map>()) if (r['goal'] != null) '${r['goal']}'};
            final shown = list.cast<Map>().where((r) => _goal == null || r['goal'] == _goal).toList();
            return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              // Group routines by the goal they serve.
              if (goals.isNotEmpty)
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(children: [
                    Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: const Text('All goals'), selected: _goal == null, onSelected: (_) => setState(() => _goal = null))),
                    for (final g in goals) Padding(padding: const EdgeInsets.only(right: 6), child: ChoiceChip(label: Text(goalLabels[g] ?? g), selected: _goal == g, onSelected: (_) => setState(() => _goal = g))),
                  ]),
                ),
              for (final r in shown) _routineCard(context, Map<String, dynamic>.from(r)),
            ]);
          },
        ),
        const SizedBox(height: 18),
        Text('Ideas to get started', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Loader<List>(
          load: () async => ((await app.api.get('/routines/ideas')) as Map)['ideas'] as List,
          builder: (context, ideas, _) {
            final all = ideas.cast<Map>();
            if (!_ideaOpened && widget.idea != null) {
              _ideaOpened = true;
              final i = all.where((x) => x['id'] == widget.idea).firstOrNull;
              if (i != null) WidgetsBinding.instance.addPostFrameCallback((_) => _edit(_fromIdea(i)));
            }
            final cats = ['All', ...{for (final i in all) '${i['category']}'}];
            final shown = all.where((i) => _cat == 'All' || i['category'] == _cat);
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Wrap(spacing: 6, runSpacing: 6, children: [for (final c in cats) ChoiceChip(label: Text(c), selected: _cat == c, onSelected: (_) => setState(() => _cat = c))]),
              const SizedBox(height: 8),
              for (final i in shown)
                Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: Icon(iconFor('${i['icon']}')),
                    title: Text('${i['title']}'),
                    subtitle: Text('${i['blurb']}\n${scheduleText(i['days'] as List, '${i['time']}')}'),
                    isThreeLine: true,
                    trailing: TextButton(onPressed: () => _edit(_fromIdea(i)), child: const Text('Use this')),
                  ),
                ),
            ]);
          },
        ),
      ]),
    );
  }

  Map<String, dynamic> _fromIdea(Map i) => {'title': i['title'], 'prompt': i['prompt'], 'time_local': i['time'], 'days': i['days'], 'catalog_id': i['id'], 'needs': i['needs']};

  Widget _routineCard(BuildContext context, Map<String, dynamic> r) {
    final api = AppState.read(context).api;
    final t = Theme.of(context).textTheme;
    final custom = r['custom'] == true;
    final steps = (r['steps'] as List?) ?? const [];
    final access = r['access_summary'] as Map?;
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${r['title']}', style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600)),
                Text('${scheduleText(r['days'] as List, '${r['time_local']}')}${custom ? '' : ' · built in'}${r['goal'] != null ? ' · ${goalLabels[r['goal']] ?? r['goal']}' : ''}', style: t.bodySmall),
              ]),
            ),
            Switch(
              value: r['enabled'] == true,
              onChanged: (v) async {
                try {
                  await api.patch('/routines/${r['id']}', {'enabled': v});
                } catch (e) {
                  if (context.mounted) toast(context, errorText(e), error: true);
                }
                _reload();
              },
            ),
          ]),
          const SizedBox(height: 6),
          Text(custom ? '${r['prompt'] ?? ''}' : _builtIn[r['kind']] ?? ''),
          if (custom && steps.isNotEmpty) ...[
            const SizedBox(height: 4),
            for (var n = 0; n < steps.length; n++) Text('${n + 1}. ${steps[n]}', style: t.bodySmall),
          ],
          if (custom && access != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(access['everything'] == true ? 'Can use everything Carino can' : 'Can: ${[...(access['does'] as List? ?? const [])].join('; ')}${(access['asks'] as List?)?.isNotEmpty == true ? ' · asks first before ${(access['asks'] as List).join('; ')}' : ''}',
                  style: t.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
            ),
          if (r['last_run_at'] != null) ...[
            const Divider(height: 18),
            Row(children: [
              Text('Last run ${fmtDateTime(r['last_run_at'] as String?)} ', style: t.bodySmall),
              Pill(r['last_status'] == 'failed' ? 'failed' : 'ok', color: r['last_status'] == 'failed' ? Theme.of(context).colorScheme.error : Colors.green),
            ]),
            if (r['last_status'] == 'failed' && r['last_error'] != null) Text('${r['last_error']}', style: t.bodySmall?.copyWith(color: Theme.of(context).colorScheme.error)),
            if (r['last_status'] != 'failed' && r['last_result'] != null) MarkdownBody(data: '${r['last_result']}'),
          ],
          const SizedBox(height: 6),
          Wrap(spacing: 4, children: [
            if (custom)
              TextButton.icon(
                onPressed: _running == r['id']
                    ? null
                    : () async {
                        setState(() => _running = r['id'] as String);
                        try {
                          await api.post('/routines/${r['id']}/run');
                          if (context.mounted) toast(context, '“${r['title']}” ran — see the result above');
                        } catch (e) {
                          if (context.mounted) toast(context, errorText(e), error: true);
                        } finally {
                          if (mounted) setState(() => _running = null);
                          _reload();
                        }
                      },
                icon: const Icon(Icons.play_arrow, size: 18),
                label: Text(_running == r['id'] ? 'Running…' : 'Run now'),
              ),
            TextButton.icon(onPressed: () => _edit({'id': r['id'], 'title': r['title'], 'prompt': r['prompt'] ?? '', 'time_local': r['time_local'], 'days': r['days'], 'steps': r['steps'] ?? [], 'access': r['access'], 'goal': r['goal'], 'builtIn': !custom}), icon: const Icon(Icons.edit_outlined, size: 18), label: const Text('Edit')),
            if (r['conversation_id'] != null) TextButton.icon(onPressed: () => openPath(context, '/chat/${r['conversation_id']}'), icon: const Icon(Icons.chat_bubble_outline, size: 18), label: const Text('Open chat')),
            if (custom)
              TextButton.icon(
                onPressed: () async {
                  if (!await confirmDialog(context, title: 'Delete “${r['title']}”?', body: 'It will stop running. Its chat history stays in Chats.', confirm: 'Delete', danger: true)) return;
                  await api.delete('/routines/${r['id']}');
                  _reload();
                },
                icon: const Icon(Icons.delete_outline, size: 18),
                label: const Text('Delete'),
              ),
          ]),
        ]),
      ),
    );
  }
}

/// Create or edit a routine: name, instructions, steps, what it may use, time and days.
class RoutineEditor extends StatefulWidget {
  final Map<String, dynamic> draft;
  const RoutineEditor({super.key, required this.draft});
  @override
  State<RoutineEditor> createState() => _RoutineEditorState();
}

class _RoutineEditorState extends State<RoutineEditor> {
  late final _title = TextEditingController(text: '${widget.draft['title'] ?? ''}');
  late final _prompt = TextEditingController(text: '${widget.draft['prompt'] ?? ''}');
  late List<TextEditingController> _steps = [for (final s in (widget.draft['steps'] as List? ?? const [])) TextEditingController(text: '$s')];
  late List<String>? _access = (widget.draft['access'] as List?)?.cast<String>().toList();
  late TimeOfDay _time = _parse('${widget.draft['time_local'] ?? '08:00'}');
  late final Set<int> _days = {for (final d in (widget.draft['days'] as List? ?? const [1, 2, 3, 4, 5])) (d as num).toInt()};
  late String? _goalSel = widget.draft['goal'] as String?;
  bool _saving = false;
  bool get _builtIn => widget.draft['builtIn'] == true;

  static TimeOfDay _parse(String s) {
    final p = s.split(':');
    return TimeOfDay(hour: int.tryParse(p.first) ?? 8, minute: int.tryParse(p.length > 1 ? p[1] : '0') ?? 0);
  }

  String get _timeText => '${_time.hour.toString().padLeft(2, '0')}:${_time.minute.toString().padLeft(2, '0')}';
  List<String> get _blanks => RegExp(r'\[[^\]]+\]').allMatches(_prompt.text).map((m) => m.group(0)!).toList();

  Future<void> _save() async {
    setState(() => _saving = true);
    final api = AppState.read(context).api;
    final days = _order.where(_days.contains).toList();
    final custom = {
      'title': _title.text.trim(), 'prompt': _prompt.text.trim(), 'time_local': _timeText, 'days': days,
      'steps': [for (final c in _steps) if (c.text.trim().isNotEmpty) c.text.trim()], 'access': _access, 'goal': _goalSel,
    };
    try {
      final id = widget.draft['id'];
      if (id != null) {
        await api.patch('/routines/$id', _builtIn ? {'time_local': _timeText, 'days': days} : custom);
      } else {
        await api.post('/routines', {...custom, 'catalog_id': ?widget.draft['catalog_id']});
      }
      if (mounted) {
        toast(context, id != null ? 'Routine saved' : '“${_title.text.trim()}” added — ${scheduleText(days, _timeText).toLowerCase()}');
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
    final t = Theme.of(context).textTheme;
    final valid = _days.isNotEmpty && (_builtIn || (_title.text.trim().isNotEmpty && _prompt.text.trim().length >= 5 && _blanks.isEmpty));
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.9,
      builder: (context, scroll) => ListView(controller: scroll, padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom), children: [
        Text(widget.draft['id'] != null ? 'Edit routine' : 'New routine', style: t.titleLarge),
        const SizedBox(height: 12),
        if (!_builtIn) ...[
          TextField(controller: _title, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 10),
          DropdownButtonFormField<String?>(
            initialValue: _goalSel,
            decoration: const InputDecoration(labelText: 'Goal it serves (optional)'),
            items: [const DropdownMenuItem(value: null, child: Text('None')), for (final e in goalLabels.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
            onChanged: (v) => setState(() => _goalSel = v),
          ),
          const SizedBox(height: 10),
          TextField(controller: _prompt, onChanged: (_) => setState(() {}), minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'What should Carino do each time?', hintText: 'e.g. Look at what I finished this week and save a short wins note.')),
          if (_blanks.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Replace ${_blanks.join(', ')} with your own details.', style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5))),
          if ((widget.draft['needs'] as List?)?.contains('connector') == true) Padding(padding: const EdgeInsets.only(top: 4), child: Text('This idea uses a connected app (e.g. your email or calendar).', style: t.bodySmall)),
          const SizedBox(height: 12),
          Text('Steps (optional)', style: t.titleSmall),
          for (var n = 0; n < _steps.length; n++)
            Row(children: [
              Text('${n + 1}.'),
              const SizedBox(width: 6),
              Expanded(child: TextField(controller: _steps[n], decoration: InputDecoration(isDense: true, hintText: 'Step ${n + 1}'))),
              IconButton(tooltip: 'Remove step ${n + 1}', icon: const Icon(Icons.close), onPressed: () => setState(() => _steps = [..._steps]..removeAt(n))),
            ]),
          if (_steps.length < 12) Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => setState(() => _steps = [..._steps, TextEditingController()]), icon: const Icon(Icons.add), label: const Text('Add a step'))),
          const SizedBox(height: 8),
          _AccessPicker(access: _access, onChanged: (a) => setState(() => _access = a)),
        ],
        const SizedBox(height: 12),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.schedule),
          title: const Text('Time'),
          trailing: Text(_timeText, style: t.titleMedium),
          onTap: () async {
            final v = await showTimePicker(context: context, initialTime: _time);
            if (v != null) setState(() => _time = v);
          },
        ),
        Wrap(spacing: 6, children: [
          for (final d in _order) FilterChip(label: Text(_dayNames[d]), selected: _days.contains(d), onSelected: (v) => setState(() => v ? _days.add(d) : _days.remove(d))),
        ]),
        const SizedBox(height: 6),
        Text('Times are in your time zone. A routine missed by more than three hours is skipped until its next day.', style: t.bodySmall),
        const SizedBox(height: 14),
        FilledButton(onPressed: _saving || !valid ? null : _save, child: Text(_saving ? 'Saving…' : widget.draft['id'] != null ? 'Save' : 'Add routine')),
      ]),
    );
  }
}

/// "Everything Carino can use" or "only what I pick", in plain words.
class _AccessPicker extends StatelessWidget {
  final List<String>? access;
  final ValueChanged<List<String>?> onChanged;
  const _AccessPicker({required this.access, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final t = Theme.of(context).textTheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('What it can use', style: t.titleSmall),
      RadioGroup<bool>(
        groupValue: access != null,
        onChanged: (v) => onChanged(v == true ? (access ?? <String>[]) : null),
        child: const Column(children: [
          RadioListTile<bool>(contentPadding: EdgeInsets.zero, value: false, title: Text('Everything Carino can use')),
          RadioListTile<bool>(contentPadding: EdgeInsets.zero, value: true, title: Text('Only what I pick')),
        ]),
      ),
      if (access != null)
        Loader<List>(
          load: () async => ((await app.api.get('/routines/access')) as Map)['groups'] as List,
          builder: (context, groups, _) => Column(children: [
            for (final g in groups.cast<Map>())
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: access!.contains(g['id']),
                onChanged: (v) => onChanged(v == true ? [...access!, '${g['id']}'] : access!.where((x) => x != g['id']).toList()),
                title: Text('${g['label']}'),
                subtitle: Text([
                  if ('${g['reads']}'.isNotEmpty) 'Reads ${g['reads']}',
                  if ('${g['does']}'.isNotEmpty) 'Can ${g['does']}',
                  if ('${g['asks']}'.isNotEmpty) 'Asks you before ${g['asks']}',
                ].join(' · ')),
              ),
          ]),
        ),
      Text('It can always look at your to-dos, notes and saved knowledge. Sending, deleting, posting and other big actions always wait for your OK.', style: t.bodySmall),
    ]);
  }
}
