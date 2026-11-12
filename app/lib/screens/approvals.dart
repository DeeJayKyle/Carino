import 'dart:convert';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Approvals: actions waiting for the user's OK (nothing runs until approved), and history.
class ApprovalsScreen extends StatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  State<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends State<ApprovalsScreen> {
  String _filter = '';
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Scaffold(
      appBar: AppBar(title: const Tx('Approvals')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        Tx('Carino runs read-only and reversible actions within your permissions. Deletions and other big actions always wait here for you.',
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        const SizedBox(height: 12),
        Loader<List>(
          reloadKey: _bump,
          load: () async => ((await app.api.get('/actions?status=pending')) as Map)['actions'] as List,
          builder: (context, list, _) => list.isEmpty
              ? const Card(child: ListTile(leading: Icon(Icons.check_circle, color: Colors.green), title: Tx('Nothing waiting for approval.')))
              : Column(children: [for (final a in list) ApprovalCard(action: Map<String, dynamic>.from(a as Map), onDecided: () => setState(() => _bump++))]),
        ),
        const SizedBox(height: 22),
        Row(children: [
          Expanded(child: Tx('History', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
          DropdownButton<String>(
            value: _filter,
            underline: const SizedBox(),
            items: const [
              DropdownMenuItem(value: '', child: Tx('All')),
              DropdownMenuItem(value: 'executed', child: Tx('Completed')),
              DropdownMenuItem(value: 'failed', child: Tx('Failed')),
              DropdownMenuItem(value: 'rejected', child: Tx('Declined')),
            ],
            onChanged: (v) => setState(() => _filter = v ?? ''),
          ),
        ]),
        Loader<List>(
          reloadKey: '$_bump|$_filter',
          load: () async => ((await app.api.get('/actions?limit=200${_filter.isEmpty ? '' : '&status=$_filter'}')) as Map)['actions'] as List,
          builder: (context, list, _) {
            final done = list.where((a) => (a as Map)['status'] != 'pending').toList();
            if (done.isEmpty) return EmptyView(icon: Icons.schedule, title: tr('No actions yet'));
            return Card(
              child: Column(children: [
                for (final a in done.cast<Map>())
                  ListTile(
                    title: Text('${a['summary']}', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    subtitle: Text([
                      '${a['tool']}'.replaceAll('_', ' '),
                      a['origin'] == 'assistant' ? 'by Carino' : a['origin'] == 'routine' ? 'routine' : 'by you',
                      fmtDateTime(a['created_at'] as String?),
                      if (a['error'] != null) '${a['error']}',
                    ].join(' · ')),
                    trailing: Pill(_statusText('${a['status']}'), color: _statusColor(context, '${a['status']}')),
                    onTap: a['conversation_id'] == null ? null : () => openPath(context, '/chat/${a['conversation_id']}'),
                  ),
              ]),
            );
          },
        ),
      ]),
    );
  }

  static String _statusText(String s) => s == 'executed' ? 'done' : s == 'rejected' ? 'declined' : s;
  static Color? _statusColor(BuildContext c, String s) => s == 'executed' ? Colors.green : s == 'failed' ? Theme.of(c).colorScheme.error : Theme.of(c).colorScheme.outline;
}

/// One action waiting for approval: what it will do, with Approve / Decline.
class ApprovalCard extends StatefulWidget {
  final Map<String, dynamic> action;
  final VoidCallback onDecided;
  const ApprovalCard({super.key, required this.action, required this.onDecided});
  @override
  State<ApprovalCard> createState() => _ApprovalCardState();
}

/// The parts of a queued message the user may rewrite before approving (matches the engine's list).
const editableFields = ['to', 'cc', 'bcc', 'subject', 'title', 'caption', 'body', 'text', 'message', 'content', 'description', 'note', 'comment', 'reply'];

class _ApprovalCardState extends State<ApprovalCard> {
  String? _busy;
  bool _details = false;
  Map<String, TextEditingController>? _edit;

  Map get _input => (widget.action['input'] as Map?) ?? const {};
  List<String> get _editable => [for (final k in editableFields) if (_input[k] is String) k];

  Future<void> _saveEdit() async {
    final a = widget.action;
    setState(() => _busy = 'edit');
    try {
      final out = await AppState.read(context).api.patch('/actions/${a['id']}', {'input': {for (final e in _edit!.entries) e.key: e.value.text}}) as Map;
      if (!mounted) return;
      setState(() {
        a['input'] = out['input'];
        a['summary'] = out['summary'];
        _edit = null;
      });
      toast(context, tr('Saved. Approve it to send.'));
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _decide(String kind) async {
    setState(() => _busy = kind);
    final a = widget.action;
    try {
      final out = await AppState.read(context).api.post('/actions/${a['id']}/$kind') as Map;
      if (!mounted) return;
      if (kind == 'approve') {
        toast(context, out['status'] == 'executed' ? 'Done: ${a['summary']}' : 'Failed: ${out['error']}', error: out['status'] != 'executed');
      } else {
        toast(context, tr('Declined — nothing was changed.'));
      }
      widget.onDecided();
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.action;
    final cs = Theme.of(context).colorScheme;
    final destructive = '${a['tool']}'.startsWith('delete');
    const risk = {'read': 'Read-only', 'reversible': 'Reversible change', 'consequential': 'Needs your approval'};
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      color: Colors.orange.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.shield_outlined, color: Colors.orange, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${a['summary']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                Text('${risk[a['risk']] ?? a['risk']} · ${'${a['tool']}'.replaceAll('_', ' ')}${a['origin'] == 'routine' ? ' · from a routine' : ''}',
                    style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant)),
              ]),
            ),
          ]),
          // A draft (email, message, post): show what it says, and let the user change it.
          if (_editable.isNotEmpty && _edit == null)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(10)),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (final k in _editable)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 4),
                    child: k == 'body' || k == 'text' || k == 'message' || k == 'content'
                        ? Text('${_input[k]}', maxLines: 12, overflow: TextOverflow.ellipsis)
                        : Text('${k[0].toUpperCase()}${k.substring(1)}: ${_input[k]}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  ),
              ]),
            ),
          if (_edit != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Column(children: [
                for (final e in _edit!.entries)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: TextField(
                      controller: e.value,
                      minLines: const {'body', 'text', 'message', 'content', 'description'}.contains(e.key) ? 4 : 1,
                      maxLines: const {'body', 'text', 'message', 'content', 'description'}.contains(e.key) ? 14 : 1,
                      decoration: InputDecoration(labelText: '${e.key[0].toUpperCase()}${e.key.substring(1)}'),
                    ),
                  ),
                Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                  TextButton(onPressed: () => setState(() => _edit = null), child: const Tx('Cancel')),
                  FilledButton.tonal(onPressed: _busy != null ? null : _saveEdit, child: Text(_busy == 'edit' ? 'Saving…' : 'Save changes')),
                ]),
              ]),
            ),
          if (_details)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(8)),
              child: SelectableText(const JsonEncoder.withIndent('  ').convert(a['input']), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            ),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            if (_editable.isNotEmpty && _edit == null)
              TextButton.icon(
                onPressed: _busy != null ? null : () => setState(() => _edit = {for (final k in _editable) k: TextEditingController(text: '${_input[k]}')}),
                icon: const Icon(Icons.edit_outlined, size: 16),
                label: const Tx('Edit'),
              ),
            TextButton(onPressed: () => setState(() => _details = !_details), child: Text(_details ? 'Hide details' : 'Details')),
            const SizedBox(width: 4),
            OutlinedButton(onPressed: _busy != null ? null : () => _decide('reject'), child: const Tx('Decline')),
            const SizedBox(width: 8),
            FilledButton(
              style: destructive ? FilledButton.styleFrom(backgroundColor: cs.error, foregroundColor: cs.onError) : null,
              onPressed: _busy != null ? null : () => _decide('approve'),
              child: Text(_busy == 'approve' ? 'Working…' : 'Approve'),
            ),
          ]),
        ]),
      ),
    );
  }
}
