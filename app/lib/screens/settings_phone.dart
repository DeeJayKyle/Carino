import 'package:flutter/material.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';
import 'settings.dart';

/// Phone calls: Carino can ring a business for you (after you approve each call) through your own
/// Twilio account. It always says it's an AI calling on your behalf, and reports the answers in chat.
class PhoneSettings extends StatefulWidget {
  const PhoneSettings({super.key});
  @override
  State<PhoneSettings> createState() => _PhoneSettingsState();
}

class _PhoneSettingsState extends State<PhoneSettings> {
  final _sid = TextEditingController();
  final _token = TextEditingController();
  final _from = TextEditingController();
  int _rev = 0;
  bool _busy = false;

  @override
  void dispose() {
    _sid.dispose();
    _token.dispose();
    _from.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() f, String msg) async {
    setState(() => _busy = true);
    try {
      await f();
      if (mounted) toast(context, msg);
      _token.clear();
      setState(() => _rev++);
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final api = AppState.of(context).api;
    final cs = Theme.of(context).colorScheme;
    return SettingsPage(
      title: 'Phone calls',
      intro: 'Optional. Ask Carino in chat to call a business, for example to check opening hours or book a table. Each call waits for your approval, starts by saying it’s an AI calling for you, and is recorded so the answers can be written up. Calls use your own Twilio account and are charged by Twilio.',
      children: [
        Loader<List>(
          reloadKey: _rev,
          load: () async => [await api.get('/phone'), ((await api.get('/phone/calls') as Map)['calls'] as List?) ?? const []],
          builder: (context, d, _) {
            final s = d[0] as Map;
            final calls = d[1] as List;
            return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (s['configured'] == true)
                Section(
                  title: 'Twilio account',
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.phone_forwarded_outlined), title: Text('Calling from ${s['from_number']}'), subtitle: Text('Account ${s['account_sid']}')),
                    Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _busy ? null : () => _run(() => api.delete('/phone'), 'Phone calls turned off'), child: Text('Forget these details', style: TextStyle(color: cs.error)))),
                  ]),
                )
              else
                Section(
                  title: 'Connect Twilio',
                  subtitle: 'Find these in your Twilio console. The auth token is kept encrypted on this device.',
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    TextField(controller: _sid, decoration: const InputDecoration(labelText: 'Account SID', hintText: 'AC…')),
                    TextField(controller: _token, obscureText: true, decoration: const InputDecoration(labelText: 'Auth token')),
                    TextField(controller: _from, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Your Twilio number', hintText: '+256700000000')),
                    const SizedBox(height: 12),
                    FilledButton(
                      onPressed: _busy ? null : () => _run(() => api.put('/phone', {'account_sid': _sid.text.trim(), 'auth_token': _token.text.trim(), 'from_number': _from.text.trim()}), 'Phone calls are ready'),
                      child: const Text('Save'),
                    ),
                  ]),
                ),
              if (calls.isNotEmpty)
                Section(
                  title: 'Recent calls',
                  child: Column(children: [
                    for (final c in calls.cast<Map>())
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(c['status'] == 'completed' ? Icons.call_made : c['status'] == 'failed' ? Icons.call_missed_outgoing : Icons.phone_in_talk_outlined),
                        title: Text('${c['to_number']} · ${c['status']}'),
                        subtitle: Text('${c['purpose']}\n${fmtDateTime(c['created_at'] as String?)}', maxLines: 3, overflow: TextOverflow.ellipsis),
                        isThreeLine: true,
                      ),
                  ]),
                ),
            ]);
          },
        ),
      ],
    );
  }
}
