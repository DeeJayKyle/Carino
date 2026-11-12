import 'dart:math';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../widgets/common.dart';
import 'settings_ai.dart';

const _names = ['Carino', 'Nia', 'Amara', 'Zuri', 'Kito', 'Sage', 'Nova', 'Juno', 'Ada', 'Leo', 'Imani', 'Tendo', 'Ayo', 'Mira', 'Kai', 'Wren'];
const _interests = <(String, String, IconData)>[
  ('organise', 'Getting organised', Icons.checklist), ('work', 'Work', Icons.work_outline), ('business', 'My business', Icons.storefront_outlined), ('money', 'Money', Icons.payments_outlined),
  ('health', 'Health', Icons.favorite_border), ('food', 'Food & meals', Icons.restaurant_outlined), ('family', 'Family & friends', Icons.people_outline), ('learn', 'Learning', Icons.menu_book_outlined),
  ('travel', 'Travel', Icons.flight_outlined), ('home', 'Home', Icons.home_outlined), ('goals', 'Goals', Icons.flag_outlined), ('shopping', 'Shopping & prices', Icons.shopping_bag_outlined),
];
/// Starter routine ideas per interest (ids from the routine catalog).
const _starters = {
  'organise': 'overdue-sweep', 'work': 'work-wins', 'business': 'business-followups', 'money': 'money-checkin', 'health': 'water-walk',
  'food': 'meal-plan', 'family': 'occasions', 'learn': 'daily-lesson', 'goals': 'week-ahead', 'home': 'week-ahead', 'travel': 'week-ahead', 'shopping': 'money-checkin',
};

/// First-run setup: names, an AI service, what to help with, and a few starter routines.
/// Everything can be changed later. Pops with the page to open next.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key});
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _you = TextEditingController();
  final _assistant = TextEditingController();
  int _step = 0;
  final _picked = <String>{'morning_briefing'};
  final _chosen = <String>[];
  String _tone = 'balanced';
  List<Map> _ideas = const [];
  List<Map> _builtIns = const [];
  List<String> _suggestions = _names.take(6).toList();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final app = AppState.read(context);
    final profile = app.settings['profile'] as Map? ?? const {};
    final n = '${profile['displayName'] ?? ''}'.trim().isNotEmpty ? '${profile['displayName']}' : '${(app.me?['user'] as Map?)?['name'] ?? ''}';
    // The phone's account starts as “Friend”; ask for a real name instead.
    _you.text = n == 'Friend' ? '' : n;
    _assistant.text = '${profile['assistantName'] ?? ''}'.trim().isEmpty ? 'Carino' : '${profile['assistantName']}';
    app.api.get('/routines/ideas').then((r) => setState(() => _ideas = (((r as Map)['ideas'] as List?) ?? const []).cast<Map>())).catchError((_) {});
    app.api.get('/routines').then((r) => setState(() => _builtIns = (((r as Map)['routines'] as List?) ?? const []).cast<Map>())).catchError((_) {});
  }

  List<Map> get _starterIdeas {
    final ids = _chosen.map((i) => _starters[i]).whereType<String>().toSet().take(4).toSet();
    return _ideas.where((i) => ids.contains(i['id']) && !RegExp(r'\[[^\]]+\]').hasMatch('${i['prompt']}')).toList();
  }

  Future<void> _finish({bool skip = false}) async {
    final app = AppState.read(context);
    setState(() => _busy = true);
    try {
      if (!skip) {
        for (final r in _builtIns) {
          if (r['custom'] != true && _picked.contains(r['kind']) != (r['enabled'] == true)) await app.api.patch('/routines/${r['id']}', {'enabled': _picked.contains(r['kind'])});
        }
        for (final i in _starterIdeas) {
          if (_picked.contains(i['id'])) await app.api.post('/routines', {'title': i['title'], 'prompt': i['prompt'], 'time_local': i['time'], 'days': i['days'], 'catalog_id': i['id']});
        }
      }
      await app.api.patch('/settings', {
        'onboarded': true,
        if (!skip) 'profile': {'displayName': _you.text.trim(), 'assistantName': _assistant.text.trim().isEmpty ? 'Carino' : _assistant.text.trim(), 'interests': _chosen, 'assistantStyle': _tone},
      });
      await app.loadMe();
      app.changed();
      if (mounted) Navigator.of(context).pop(skip ? '/' : '/discover');
    } catch (e) {
      if (mounted) {
        toast(context, errorText(e), error: true);
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final muted = TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant);
    final first = _you.text.trim().split(' ').first;
    final steps = <Widget>[
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('Hi! Let’s get you set up.', style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('I’m your personal assistant. I remember what matters, keep your to-dos and reminders, and do the small stuff you’d rather not.', style: muted),
        const SizedBox(height: 16),
        TextField(controller: _you, maxLength: 80, autofocus: true, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: tr('What should I call you?'))),
      ]),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('What will you call me?', style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('Pick a name, or type your own. You can change it any time in Settings.', style: muted),
        const SizedBox(height: 12),
        TextField(controller: _assistant, maxLength: 40, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: tr('Assistant name'))),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final n in _suggestions) ChoiceChip(label: Text(n), selected: _assistant.text == n, onSelected: (_) => setState(() => _assistant.text = n)),
          TextButton.icon(onPressed: () => setState(() => _suggestions = ([..._names]..shuffle(Random())).take(6).toList()), icon: const Icon(Icons.refresh, size: 16), label: const Tx('More names')),
        ]),
      ]),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('How should I talk to you?', style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('Pick a personality. You can change it, or teach me to sound like you, in Settings.', style: muted),
        const SizedBox(height: 12),
        for (final (v, title, example) in const [
          ('balanced', 'Balanced', 'Clear answers, more detail when it helps.'),
          ('concise', 'Short and direct', 'Straight to the point. No fluff.'),
          ('warm', 'Warm', 'Kind and encouraging, still practical.'),
          ('upbeat', 'Upbeat', 'Bright and positive, always honest.'),
          ('playful', 'A little cheeky', 'Helpful, with a wink now and then.'),
        ])
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            color: _tone == v ? Theme.of(context).colorScheme.primaryContainer : null,
            child: ListTile(
              title: Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(example),
              trailing: _tone == v ? const Icon(Icons.check_circle) : null,
              onTap: () => setState(() => _tone = v),
            ),
          ),
      ]),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('Give {0} a brain', args: [_assistant.text.trim().isEmpty ? 'me' : _assistant.text.trim()], style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('I live on your phone, and I use an AI service to think. Groq and Google Gemini are free — pick one, get a key in a minute, and paste it here. You can do this later in Settings.', style: muted),
        const SizedBox(height: 12),
        AiSettings(compact: true, onSaved: () => setState(() => _step++)),
      ]),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('What would you like help with, {0}?', args: [first.isEmpty ? 'friend' : first], style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('Choose a few. I’ll suggest the right ideas first.', style: muted),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final (id, label, icon) in _interests)
            FilterChip(
              avatar: Icon(icon, size: 18),
              label: Text(label),
              selected: _chosen.contains(id),
              onSelected: (on) => setState(() => on ? _chosen.add(id) : _chosen.remove(id)),
            ),
        ]),
      ]),
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Tx('Let’s set up your first routines', style: t.headlineSmall),
        const SizedBox(height: 8),
        Tx('Routines run on their own and send you a notification. Tick the ones you want — you can change or add more on the Routines page.', style: muted),
        const SizedBox(height: 8),
        for (final r in [
          {'id': 'morning_briefing', 'title': 'Morning briefing', 'blurb': 'Your day at 07:00: tasks, deadlines and reminders.'},
          {'id': 'evening_review', 'title': 'Evening review', 'blurb': 'At 19:00: what you finished and tomorrow’s priorities.'},
          ..._starterIdeas.map((i) => {'id': i['id'], 'title': i['title'], 'blurb': i['blurb']}),
        ])
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            controlAffinity: ListTileControlAffinity.leading,
            value: _picked.contains(r['id']),
            onChanged: (on) => setState(() => on == true ? _picked.add('${r['id']}') : _picked.remove('${r['id']}')),
            title: Text('${r['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text('${r['blurb'] ?? ''}'),
          ),
      ]),
    ];
    final last = _step == steps.length - 1;
    final canNext = !(_step == 0 && _you.text.trim().isEmpty) && !(_step == 1 && _assistant.text.trim().isEmpty);
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: SafeArea(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
              child: Row(children: [
                CircleAvatar(radius: 26, backgroundColor: Theme.of(context).colorScheme.primaryContainer, child: Icon(last ? Icons.record_voice_over : Icons.waving_hand_outlined, color: Theme.of(context).colorScheme.onPrimaryContainer)),
                const Spacer(),
                TextButton(onPressed: _busy ? null : () => _finish(skip: true), child: const Tx('Skip')),
              ]),
            ),
            Expanded(child: SingleChildScrollView(padding: const EdgeInsets.all(20), child: steps[_step])),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Row(children: [
                Expanded(
                  child: Semantics(
                    label: tr('Step {0} of {1}', [_step + 1, steps.length]),
                    child: Row(children: [
                      for (var i = 0; i < steps.length; i++)
                        Container(margin: const EdgeInsets.only(right: 6), width: i == _step ? 18 : 8, height: 8, decoration: BoxDecoration(borderRadius: BorderRadius.circular(4), color: i == _step ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.outlineVariant)),
                    ]),
                  ),
                ),
                if (_step > 0) TextButton(onPressed: _busy ? null : () => setState(() => _step--), child: const Tx('Back')),
                const SizedBox(width: 8),
                last
                    ? FilledButton(onPressed: _busy ? null : _finish, child: Text(_busy ? 'Setting up…' : 'Let’s go'))
                    : FilledButton(onPressed: canNext ? () => setState(() => _step++) : null, child: const Tx('Next')),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
