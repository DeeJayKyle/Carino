import 'dart:convert';

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
      appBar: AppBar(title: const Text('Approvals')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
        Text('Carino runs read-only and reversible actions within your permissions. Deletions and other big actions always wait here for you.',
            style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        const SizedBox(height: 12),
        Loader<List>(
          reloadKey: _bump,
          load: () async => ((await app.api.get('/actions?status=pending')) as Map)['actions'] as List,
          builder: (context, list, _) => list.isEmpty
              ? const Card(child: ListTile(leading: Icon(Icons.check_circle, color: Colors.green), title: Text('Nothing waiting for approval.')))
              : Column(children: [for (final a in list) ApprovalCard(action: Map<String, dynamic>.from(a as Map), onDecided: () => setState(() => _bump++))]),
        ),
        const SizedBox(height: 22),
        Row(children: [
          Expanded(child: Text('History', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
          DropdownButton<String>(
            value: _filter,
            underline: const SizedBox(),
            items: const [
              DropdownMenuItem(value: '', child: Text('All')),
              DropdownMenuItem(value: 'executed', child: Text('Completed')),
              DropdownMenuItem(value: 'failed', child: Text('Failed')),
              DropdownMenuItem(value: 'rejected', child: Text('Declined')),
            ],
            onChanged: (v) => setState(() => _filter = v ?? ''),
          ),
        ]),
        Loader<List>(
          reloadKey: '$_bump|$_filter',
          load: () async => ((await app.api.get('/actions?limit=200${_filter.isEmpty ? '' : '&status=$_filter'}')) as Map)['actions'] as List,
          builder: (context, list, _) {
            final done = list.where((a) => (a as Map)['status'] != 'pending').toList();
            if (done.isEmpty) return const EmptyView(icon: Icons.schedule, title: 'No actions yet');
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

class _ApprovalCardState extends State<ApprovalCard> {
  String? _busy;
  bool _details = false;

  Future<void> _decide(String kind) async {
    setState(() => _busy = kind);
    final a = widget.action;
    try {
      final out = await AppState.read(context).api.post('/actions/${a['id']}/$kind') as Map;
      if (!mounted) return;
      if (kind == 'approve') {
        toast(context, out['status'] == 'executed' ? 'Done: ${a['summary']}' : 'Failed: ${out['error']}', error: out['status'] != 'executed');
      } else {
        toast(context, 'Declined — nothing was changed.');
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
          if (_details)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(color: cs.surface, borderRadius: BorderRadius.circular(8)),
              child: SelectableText(const JsonEncoder.withIndent('  ').convert(a['input']), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
            ),
          const SizedBox(height: 8),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            TextButton(onPressed: () => setState(() => _details = !_details), child: Text(_details ? 'Hide details' : 'Details')),
            const SizedBox(width: 4),
            OutlinedButton(onPressed: _busy != null ? null : () => _decide('reject'), child: const Text('Decline')),
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
