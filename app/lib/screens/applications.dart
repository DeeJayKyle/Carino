import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import '../widgets/files.dart';
import '../widgets/ui.dart';

const _kind = {'job': 'Job', 'scholarship': 'Scholarship', 'other': 'Other'};
const _closed = {'accepted', 'rejected', 'withdrawn'};

String _day(String? d) {
  final t = DateTime.tryParse('${d ?? ''}T12:00:00');
  if (t == null) return '';
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${t.day} ${mo[t.month - 1]} ${t.year}';
}

int _daysUntil(String d) {
  final now = DateTime.now();
  return DateTime.parse(d).difference(DateTime(now.year, now.month, now.day)).inDays;
}

String _ymd(DateTime p) => '${p.year}-${p.month.toString().padLeft(2, '0')}-${p.day.toString().padLeft(2, '0')}';

/// Jobs and scholarships: deadlines, eligibility, documents, referees, progress and follow-ups.
class ApplicationsScreen extends StatefulWidget {
  const ApplicationsScreen({super.key});
  @override
  State<ApplicationsScreen> createState() => _ApplicationsScreenState();
}

class _ApplicationsScreenState extends State<ApplicationsScreen> {
  String _k = '';
  bool _showClosed = false;
  int _bump = 0;

  Future<void> _open(String id, List statuses) async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ApplicationDetail(id: id, statuses: statuses.cast<Map>())));
    setState(() => _bump++);
  }

  Future<void> _add(List statuses) async {
    final id = await showModalBottomSheet<String>(context: context, isScrollControlled: true, useSafeArea: true, builder: (_) => const _AddApplication());
    if (id != null && mounted) await _open(id, statuses);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Loader<Map>(
      reloadKey: '$_bump|$_k',
      load: () async => await app.api.get('/applications${_k.isEmpty ? '' : '?kind=$_k'}') as Map,
      builder: (context, data, reload) {
        final statuses = (data['statuses'] as List).cast<Map>();
        String label(String s) => '${statuses.firstWhere((x) => x['id'] == s, orElse: () => {'label': s})['label']}';
        final list = (data['applications'] as List).cast<Map>().where((a) => _showClosed || !_closed.contains(a['status'])).toList();
        return Scaffold(
          appBar: AppBar(title: const Text('Applications')),
          floatingActionButton: FloatingActionButton.extended(onPressed: () => _add(statuses), icon: const Icon(Icons.add), label: const Text('Add')),
          body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 96), children: [
            Text('Jobs and scholarships: deadlines, whether you qualify, documents and referees, and when to follow up. Or tell Carino “track this job…” and paste the advert.',
                style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
            const SizedBox(height: 10),
            Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              for (final (id, l) in const [('', 'All'), ('job', 'Jobs'), ('scholarship', 'Scholarships')]) ChoiceChip(label: Text(l), selected: _k == id, onSelected: (_) => setState(() => _k = id)),
              FilterChip(label: const Text('Show finished'), selected: _showClosed, onSelected: (v) => setState(() => _showClosed = v)),
            ]),
            const SizedBox(height: 10),
            if (list.isEmpty)
              EmptyView(icon: Icons.work_outline, title: 'Nothing tracked yet', body: 'Add a job or scholarship, and Carino reminds you before the deadline and to follow up after you apply.', action: FilledButton(onPressed: () => _add(statuses), child: const Text('Add one')))
            else
              Card(
                child: Column(children: [
                  for (final a in list) _row(context, a, label),
                ]),
              ),
          ]),
        );
      },
    );
  }

  Widget _row(BuildContext context, Map a, String Function(String) label) {
    final cs = Theme.of(context).colorScheme;
    final left = a['deadline'] != null ? _daysUntil('${a['deadline']}') : null;
    final open = !_closed.contains(a['status']);
    final urgent = left != null && left <= 7 && left >= 0 && open && ['interested', 'preparing'].contains(a['status']);
    final p = (a['progress'] as Map?) ?? const {};
    final missing = (p['missing'] as List? ?? const []).cast<String>();
    return ListTile(
      title: Text('${a['title']}${a['organisation'] != null ? ' · ${a['organisation']}' : ''}', style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const SizedBox(height: 4),
        Wrap(spacing: 6, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
          Pill(_kind[a['kind']] ?? '${a['kind']}', color: cs.outline),
          Pill(label('${a['status']}'), color: open ? cs.primary : cs.outline),
          if (a['deadline'] != null)
            Text('${left! < 0 ? 'Closed' : 'Closes'} ${_day('${a['deadline']}')}${urgent ? ' · ${left == 0 ? 'today' : '$left day${left == 1 ? '' : 's'} left'}' : ''}', style: TextStyle(fontSize: 12, color: urgent ? cs.error : null)),
          if (a['follow_up_on'] != null && open) Text('follow up ${_day('${a['follow_up_on']}')}', style: const TextStyle(fontSize: 12)),
          if (a['eligible'] == 'no') Text('may not qualify', style: TextStyle(fontSize: 12, color: cs.error)),
        ]),
        if ((p['total'] as num? ?? 0) > 0)
          Text('${p['ready']} of ${p['total']} ready${missing.isEmpty ? '' : ' · still need ${missing.take(3).join(', ')}${missing.length > 3 ? '…' : ''}'}', style: const TextStyle(fontSize: 12)),
      ]),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => _open('${a['id']}', const []),
    );
  }
}

class _AddApplication extends StatefulWidget {
  const _AddApplication();
  @override
  State<_AddApplication> createState() => _AddApplicationState();
}

class _AddApplicationState extends State<_AddApplication> {
  String _kind = 'job';
  final _title = TextEditingController();
  final _org = TextEditingController();
  final _url = TextEditingController();
  String? _deadline;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Track an application', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        SegmentedButton<String>(segments: const [ButtonSegment(value: 'job', label: Text('Job')), ButtonSegment(value: 'scholarship', label: Text('Scholarship')), ButtonSegment(value: 'other', label: Text('Other'))], selected: {_kind}, onSelectionChanged: (s) => setState(() => _kind = s.first)),
        const SizedBox(height: 10),
        TextField(controller: _title, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: _kind == 'scholarship' ? 'Scholarship' : 'Role')),
        const SizedBox(height: 10),
        TextField(controller: _org, decoration: const InputDecoration(labelText: 'Organisation')),
        const SizedBox(height: 10),
        TextField(controller: _url, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'Link (optional)')),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Deadline'),
          trailing: Text(_deadline == null ? 'Choose' : _day(_deadline)),
          onTap: () async {
            final p = await showDatePicker(context: context, firstDate: DateTime.now().subtract(const Duration(days: 30)), lastDate: DateTime.now().add(const Duration(days: 3650)), initialDate: DateTime.now().add(const Duration(days: 14)));
            if (p != null) setState(() => _deadline = _ymd(p));
          },
        ),
        FilledButton(
          onPressed: _title.text.trim().isEmpty
              ? null
              : () async {
                  try {
                    final a = await AppState.read(context).api.post('/applications', {
                      'kind': _kind, 'title': _title.text.trim(),
                      if (_org.text.trim().isNotEmpty) 'organisation': _org.text.trim(),
                      'deadline': ?_deadline,
                      if (_url.text.trim().isNotEmpty) 'url': _url.text.trim(),
                    }) as Map;
                    if (!context.mounted) return;
                    toast(context, a['deadline_reminder_id'] != null ? 'Added — Carino reminds you 3 days before the deadline' : 'Added');
                    Navigator.pop(context, '${a['id']}');
                  } catch (e) {
                    if (context.mounted) toast(context, errorText(e), error: true);
                  }
                },
          child: const Text('Add'),
        ),
      ]),
    );
  }
}

/// One application: status, dates, eligibility, the checklist (documents, referees), notes, history.
class ApplicationDetail extends StatefulWidget {
  final String id;
  final List<Map> statuses;
  const ApplicationDetail({super.key, required this.id, required this.statuses});
  @override
  State<ApplicationDetail> createState() => _ApplicationDetailState();
}

class _ApplicationDetailState extends State<ApplicationDetail> {
  Map? _a;
  List<Map> _statuses = const [];
  final _draft = <String, dynamic>{};
  final _c = <String, TextEditingController>{};
  String _newKind = 'document';
  final _newLabel = TextEditingController();
  final _newContact = TextEditingController();

  @override
  void initState() {
    super.initState();
    _statuses = widget.statuses;
    _load();
  }

  Future<void> _load() async {
    final api = AppState.read(context).api;
    final a = await api.get('/applications/${widget.id}') as Map;
    if (_statuses.isEmpty) _statuses = (((await api.get('/applications')) as Map)['statuses'] as List).cast<Map>();
    if (!mounted) return;
    setState(() {
      _a = a;
      for (final k in ['organisation', 'eligibility', 'next_step', 'value', 'notes']) {
        (_c[k] ??= TextEditingController()).text = '${a[k] ?? ''}';
      }
    });
  }

  Future<void> _run(Future<dynamic> Function() fn, [String? ok]) async {
    try {
      await fn();
      if (mounted && ok != null) toast(context, ok);
      await _load();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  Future<void> _save([Map<String, dynamic>? body]) async {
    final b = body ?? Map<String, dynamic>.from(_draft);
    if (b.isEmpty) return;
    await _run(() => AppState.read(context).api.patch('/applications/${widget.id}', b), 'Saved');
    if (body == null) setState(_draft.clear);
  }

  TextField _field(String key, String label, {int lines = 1}) => TextField(
        controller: _c[key],
        minLines: lines,
        maxLines: lines == 1 ? 1 : 6,
        decoration: InputDecoration(labelText: label),
        onChanged: (v) => setState(() => _draft[key] = v),
      );

  Widget _date(String key, String label) {
    final v = _draft.containsKey(key) ? _draft[key] : _a![key];
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(label),
      subtitle: Text(v == null ? 'Not set' : _day('$v')),
      trailing: v == null ? const Icon(Icons.event) : IconButton(icon: const Icon(Icons.close), tooltip: 'Clear', onPressed: () => setState(() => _draft[key] = null)),
      onTap: () async {
        final p = await showDatePicker(context: context, firstDate: DateTime(2000), lastDate: DateTime(2100), initialDate: DateTime.tryParse('${v ?? ''}') ?? DateTime.now());
        if (p != null) setState(() => _draft[key] = _ymd(p));
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final a = _a;
    if (a == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    final api = AppState.read(context).api;
    final cs = Theme.of(context).colorScheme;
    final p = (a['progress'] as Map?) ?? const {};
    final eligible = _draft.containsKey('eligible') ? _draft['eligible'] : a['eligible'];
    return Scaffold(
      appBar: AppBar(title: Text('${a['title']}'), actions: [
        IconButton(
          tooltip: 'Delete',
          icon: const Icon(Icons.delete_outline),
          onPressed: () async {
            if (!await confirmDialog(context, title: 'Delete this application?', body: 'Its checklist, history and reminders go too. Attached files stay in Carino.', confirm: 'Delete', danger: true)) return;
            await api.delete('/applications/${widget.id}');
            if (context.mounted) Navigator.pop(context);
          },
        ),
      ]),
      bottomNavigationBar: _draft.isEmpty ? null : SafeArea(child: Padding(padding: const EdgeInsets.all(12), child: FilledButton(onPressed: _save, child: const Text('Save changes')))),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        DropdownButtonFormField<String>(
          initialValue: '${a['status']}',
          decoration: const InputDecoration(labelText: 'Status'),
          items: [for (final s in _statuses) DropdownMenuItem(value: '${s['id']}', child: Text('${s['label']}'))],
          onChanged: (v) => _save({'status': v}),
        ),
        if (a['status'] == 'applied' && a['follow_up_on'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Carino reminds you to follow up on ${_day('${a['follow_up_on']}')}.', style: Theme.of(context).textTheme.bodySmall)),
        _date('deadline', 'Deadline'),
        _date('follow_up_on', 'Follow up on'),
        _field('organisation', 'Organisation'),
        const SizedBox(height: 14),
        Text('Eligibility — the requirements, and how you meet them', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        Wrap(spacing: 6, children: [
          for (final (v, l) in const [('yes', 'I qualify'), ('unsure', 'Not sure'), ('no', 'I don’t qualify')]) ChoiceChip(label: Text(l), selected: eligible == v, onSelected: (_) => setState(() => _draft['eligible'] = v)),
        ]),
        const SizedBox(height: 8),
        _field('eligibility', 'Requirements', lines: 3),
        const SizedBox(height: 10),
        _field('next_step', 'Next step'),
        const SizedBox(height: 10),
        _field('value', 'Salary or award'),
        if (a['url'] != null) Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: () => launchUrl(Uri.parse('${a['url']}'), mode: LaunchMode.externalApplication), icon: const Icon(Icons.open_in_new), label: const Text('Open the advert'))),
        const SizedBox(height: 14),
        Row(children: [Text('Checklist', style: Theme.of(context).textTheme.titleMedium), const SizedBox(width: 8), Text('${p['ready'] ?? 0} of ${p['total'] ?? 0} ready', style: Theme.of(context).textTheme.bodySmall)]),
        for (final it in (a['items'] as List).cast<Map>())
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: it['status'] == 'done' || it['status'] == 'ready',
            onChanged: (v) => _run(() => api.patch('/application-items/${it['id']}', {'status': v == true ? 'done' : 'needed'})),
            title: Text('${it['label']}'),
            subtitle: Text('${it['kind'] == 'referee' ? 'Referee${it['contact'] != null ? ' · ${it['contact']}' : ''}' : it['kind'] == 'document' ? 'Document' : 'Requirement'}${it['status'] == 'requested' ? ' · asked' : ''}${it['document_id'] != null ? ' · 📎 ${it['document_name'] ?? 'file'}' : ''}'),
            secondary: Row(mainAxisSize: MainAxisSize.min, children: [
              if (it['kind'] == 'referee' && it['status'] == 'needed') TextButton(onPressed: () => _run(() => api.patch('/application-items/${it['id']}', {'status': 'requested'}), 'Marked as asked'), child: const Text('Asked')),
              if (it['kind'] == 'document' && it['document_id'] == null)
                IconButton(
                  tooltip: 'Attach a file',
                  icon: const Icon(Icons.attach_file),
                  onPressed: () async {
                    final files = await pickUploads(fields: const {'tags': 'application'});
                    if (files.isEmpty || !context.mounted) return;
                    await _run(() async {
                      final r = await api.upload(files.first);
                      await api.patch('/application-items/${it['id']}', {'document_id': (r['document'] as Map)['id'], 'status': 'ready'});
                    }, 'File attached');
                  },
                ),
              IconButton(tooltip: 'Remove ${it['label']}', icon: const Icon(Icons.close), onPressed: () => _run(() => api.delete('/application-items/${it['id']}'))),
            ]),
          ),
        Row(children: [
          DropdownButton<String>(value: _newKind, items: const [DropdownMenuItem(value: 'document', child: Text('Document')), DropdownMenuItem(value: 'referee', child: Text('Referee')), DropdownMenuItem(value: 'requirement', child: Text('Requirement'))], onChanged: (v) => setState(() => _newKind = v ?? 'document')),
          const SizedBox(width: 8),
          Expanded(child: TextField(controller: _newLabel, onChanged: (_) => setState(() {}), decoration: InputDecoration(isDense: true, hintText: _newKind == 'referee' ? 'Referee’s name' : _newKind == 'document' ? 'CV, transcript…' : 'e.g. Practising licence'))),
          IconButton(
            tooltip: 'Add',
            icon: const Icon(Icons.add_circle_outline),
            onPressed: _newLabel.text.trim().isEmpty
                ? null
                : () => _run(() async {
                      await api.post('/applications/${widget.id}/items', {'kind': _newKind, 'label': _newLabel.text.trim(), if (_newContact.text.trim().isNotEmpty) 'contact': _newContact.text.trim()});
                      _newLabel.clear();
                      _newContact.clear();
                    }),
          ),
        ]),
        if (_newKind == 'referee') TextField(controller: _newContact, decoration: const InputDecoration(isDense: true, hintText: 'Referee’s email or phone')),
        const SizedBox(height: 14),
        _field('notes', 'Notes', lines: 3),
        if ((a['events'] as List? ?? const []).isNotEmpty)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('History', style: TextStyle(color: cs.onSurfaceVariant)),
            children: [for (final e in (a['events'] as List).cast<Map>()) ListTile(dense: true, title: Text('${e['text']}'), subtitle: Text(_day('${e['created_at']}'.substring(0, 10))))],
          ),
      ]),
    );
  }
}
