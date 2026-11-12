import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import 'web_screen.dart';

/// To-dos: today, upcoming, no date, all and done; add, tick off and reopen.
class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key});
  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

const _views = [('today', 'Today'), ('upcoming', 'Upcoming'), ('inbox', 'No date'), ('all', 'All'), ('completed', 'Done')];

class _TasksScreenState extends State<TasksScreen> {
  String _view = 'today';
  final _add = TextEditingController();
  int _bump = 0;

  @override
  void dispose() {
    _add.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    final title = _add.text.trim();
    if (title.isEmpty) return;
    final app = AppState.read(context);
    try {
      await app.api.post('/tasks', {'title': title, if (_view == 'today') 'due_at': _endOfToday()});
      _add.clear();
      setState(() => _bump++);
      if (mounted) toast(context, tr('Added “{0}”', [title]));
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Tx('To-dos'), actions: [
        IconButton(tooltip: tr('Projects and more'), icon: const Icon(Icons.open_in_new), onPressed: () => WebScreen.open(context, '/tasks')),
      ]),
      body: Column(children: [
        SizedBox(
          height: 44,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
            for (final (id, label) in _views)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: ChoiceChip(label: Text(label), selected: _view == id, onSelected: (_) => setState(() => _view = id)),
              ),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
          child: TextField(
            controller: _add,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _create(),
            decoration: InputDecoration(
              hintText: _view == 'today' ? 'Add a to-do for today' : 'Add a to-do',
              prefixIcon: const Icon(Icons.add),
              suffixIcon: IconButton(icon: const Icon(Icons.check), tooltip: tr('Add'), onPressed: _create),
            ),
          ),
        ),
        Expanded(
          child: Loader<List>(
            reloadKey: '${app.revision}|$_view|$_bump',
            load: () async => ((await app.api.get('/tasks?view=$_view')) as Map)['tasks'] as List,
            builder: (context, list, reload) {
              if (list.isEmpty) {
                return Center(child: Text(_view == 'completed' ? 'Nothing done yet.' : _view == 'today' ? 'Nothing due today 🎉' : 'Nothing here.'));
              }
              return RefreshIndicator(
                onRefresh: reload,
                child: ListView.builder(
                  itemCount: list.length,
                  itemBuilder: (context, i) => _TaskTile(task: Map<String, dynamic>.from(list[i] as Map), changed: reload),
                ),
              );
            },
          ),
        ),
      ]),
    );
  }

  static String _endOfToday() {
    final n = DateTime.now();
    return DateTime(n.year, n.month, n.day, 23, 59).toUtc().toIso8601String();
  }
}

class _TaskTile extends StatelessWidget {
  final Map<String, dynamic> task;
  final Future<void> Function() changed;
  const _TaskTile({required this.task, required this.changed});

  @override
  Widget build(BuildContext context) {
    final done = task['status'] == 'done';
    final due = DateTime.tryParse('${task['due_at'] ?? ''}')?.toLocal();
    final overdue = !done && due != null && due.isBefore(DateTime.now());
    final cs = Theme.of(context).colorScheme;
    final sub = <String>[
      if (due != null) dueLabel(due, allDay: task['all_day'] == true),
      if (task['project_name'] != null) '${task['project_name']}',
      if ((task['subtask_count'] as num? ?? 0) > 0) '${task['subtask_done']}/${task['subtask_count']} steps',
    ];
    return Dismissible(
      key: ValueKey(task['id']),
      direction: DismissDirection.endToStart,
      background: Container(color: cs.errorContainer, alignment: Alignment.centerRight, padding: const EdgeInsets.only(right: 20), child: Icon(Icons.delete_outline, color: cs.onErrorContainer)),
      confirmDismiss: (_) async {
        try {
          await AppState.read(context).api.delete('/tasks/${task['id']}');
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Tx('Deleted “{0}”', args: [task['title']]),
              action: SnackBarAction(label: tr('Undo'), onPressed: () async {
                await AppState.read(context).api.post('/tasks', {'title': task['title'], 'due_at': task['due_at'], 'priority': task['priority'], 'description': task['description'] ?? ''});
                await changed();
              }),
            ));
          }
          return true;
        } catch (e) {
          if (context.mounted) toast(context, errorText(e), error: true);
          return false;
        }
      },
      child: CheckboxListTile(
        controlAffinity: ListTileControlAffinity.leading,
        value: done,
        title: Text('${task['title']}', style: done ? TextStyle(decoration: TextDecoration.lineThrough, color: cs.onSurfaceVariant) : null),
        subtitle: sub.isEmpty ? null : Text(sub.join(' · '), style: TextStyle(color: overdue ? cs.error : null)),
        secondary: (task['priority'] as num? ?? 0) >= 3 ? Icon(Icons.flag, color: cs.tertiary, size: 18) : null,
        onChanged: (v) async {
          try {
            await AppState.read(context).api.post('/tasks/${task['id']}/${v == true ? 'complete' : 'reopen'}');
            await changed();
          } catch (e) {
            if (context.mounted) toast(context, errorText(e), error: true);
          }
        },
      ),
    );
  }
}

/// "Today 15:00", "Tomorrow", "Fri 21 Nov 09:30".
String dueLabel(DateTime d, {bool allDay = false, DateTime? now}) {
  final n = now ?? DateTime.now();
  final today = DateTime(n.year, n.month, n.day);
  final day = DateTime(d.year, d.month, d.day);
  final diff = day.difference(today).inDays;
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final date = diff == 0 ? 'Today' : diff == 1 ? 'Tomorrow' : diff == -1 ? 'Yesterday' : '${wd[d.weekday - 1]} ${d.day} ${mo[d.month - 1]}';
  if (allDay) return date;
  return '$date ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}
