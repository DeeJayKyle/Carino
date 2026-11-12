import 'package:carino/app_state.dart';
import 'package:carino/engine/engine.dart';
import 'package:carino/main.dart';
import 'package:carino/screens/tasks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_engine.dart';

FakeEngine world({bool onboarded = true}) {
  var setUp = onboarded;
  final tasks = [
    {'id': 't1', 'title': 'Buy paracetamol stock', 'status': 'open', 'priority': 2, 'due_at': DateTime.now().add(const Duration(hours: 2)).toUtc().toIso8601String(), 'all_day': false},
    {'id': 't2', 'title': 'Call Sam', 'status': 'open', 'priority': 3, 'due_at': null},
  ];
  final e = FakeEngine(routes: {
    'GET /auth/me': (_) => me(onboarded: setUp),
    'PATCH /settings': (b) {
      if ((b as Map)['onboarded'] == true) setUp = true;
      return {'ok': true};
    },
    'GET /dashboard': (_) => {
          'hour': 9,
          'briefing': 'Good morning, Herbert. 1 task due today.',
          'overview': {'due': [tasks.first], 'overdue': [], 'reminders': [{'id': 'r1', 'title': 'Call the bank', 'at': '15:00'}], 'pendingActions': 1},
          'notifications': [],
          'recentConversations': [{'id': 'c1', 'title': 'Plan my week', 'updated_at': DateTime.now().toUtc().toIso8601String()}],
        },
    'GET /conversations': (_) => {'conversations': [{'id': 'c1', 'title': 'Plan my week', 'preview': 'Here is **your** plan', 'updated_at': DateTime.now().toUtc().toIso8601String()}]},
    'POST /conversations': (_) => {'id': 'c2', 'title': 'New conversation'},
    'GET /conversations/c1': (_) => {'conversation': {'id': 'c1', 'title': 'Plan my week', 'local_only': 0}, 'messages': [
          {'id': 'm1', 'role': 'user', 'content': 'Plan my week', 'meta': {}},
          {'id': 'm2', 'role': 'assistant', 'content': 'Here is **your** plan.', 'meta': {'model': 'qwen3:8b'}},
        ]},
    'GET /conversations/c2': (_) => {'conversation': {'id': 'c2', 'title': 'New conversation', 'local_only': 0}, 'messages': []},
    'PATCH /conversations/c1/local-only': (b) => {'local_only': (b as Map)['local_only']},
    'GET /tasks': (_) => {'tasks': tasks},
    'POST /tasks': (b) => {'id': 't3', ...(b as Map)},
    'POST /tasks/t2/complete': (_) => {'ok': true},
    'GET /money': (_) => {
          'books': [{'id': null, 'name': 'Personal'}], 'book': null, 'month': '2026-11', 'today': '2026-11-12', 'currency': 'UGX',
          'categories': [{'id': 'food', 'label': 'Eating out'}], 'total': 45000, 'count': 1, 'other': [], 'income': 0, 'net': -45000,
          'week': {'total': 45000, 'previous': 0}, 'budgets': [], 'daysLeft': 18, 'byCategory': [{'category': 'food', 'label': 'Eating out', 'total': 45000}],
          'expenses': [{'id': 'e1', 'amount': 45000, 'currency': 'UGX', 'category': 'food', 'note': 'Lunch', 'spent_on': '2026-11-12', 'updated_at': '2026-11-12T08:00:00Z'}],
          'income_list': [], 'bills': [], 'debts': [], 'goals': [],
        },
    'GET /stuff': (_) => {'tasks': {'open': 2, 'overdue': 0, 'dueToday': 1}, 'money': {'spent': 45000, 'currency': 'UGX', 'over': 0}, 'routines': {'active': 1, 'custom': 0}, 'memories': {'active': 3, 'waiting': 1}, 'reminders': {}, 'approvals': 1, 'folders': 0, 'files': 0},
    'GET /actions?status=pending': (_) => {'actions': [{'id': 'a1', 'summary': 'Delete task "Old"', 'tool': 'delete_task', 'risk': 'consequential', 'input': {'task_id': 't9'}}]},
    'GET /actions': (_) => {'actions': [{'id': 'a2', 'summary': 'Create task "X"', 'tool': 'create_task', 'risk': 'reversible', 'status': 'executed', 'origin': 'assistant', 'created_at': '2026-11-12T08:00:00Z'}]},
    'POST /actions/a1/approve': (_) => {'status': 'executed'},
    'GET /memories': (_) => {'memories': [{'id': 'mm1', 'content': 'Prefers short answers', 'category': 'preference', 'status': 'active', 'source': 'user', 'created_at': '2026-11-01T08:00:00Z'}]},
  }, chat: (body) => [
        const SseEvent('start', {'provider': {'label': 'Ollama', 'model': 'qwen3:8b', 'reason': 'Kept on your devices'}}),
        const SseEvent('tool', {'id': 'x', 'name': 'create_task', 'status': 'running'}),
        const SseEvent('tool', {'id': 'x', 'name': 'create_task', 'status': 'executed', 'summary': 'Create task "Call Mama"'}),
        const SseEvent('switch', {'provider': {'label': 'Groq', 'model': 'llama', 'reason': 'Ollama wasn’t available, so Groq answered'}}),
        const SseEvent('text', {'delta': 'Added '}),
        const SseEvent('text', {'delta': '**Call Mama**.'}),
        const SseEvent('message', {'message': {'id': 'm9', 'role': 'assistant', 'content': 'Added **Call Mama**.', 'meta': {'model': 'llama', 'tools': [{'id': 'x', 'name': 'create_task', 'status': 'executed', 'summary': 'Create task "Call Mama"'}]}}}),
      ]);
  return e;
}

Future<void> boot(WidgetTester tester, FakeEngine e) async {
  await tester.pumpWidget(CarinoApp(state: AppState(e)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('starts, greets and shows the day at a glance', (tester) async {
    final e = world();
    await boot(tester, e);
    expect(find.text('Good morning, Herbert'), findsOneWidget);
    expect(find.textContaining('1 task due today'), findsOneWidget);
    expect(find.text('Plan my week'), findsOneWidget);
    expect(find.textContaining('need'), findsOneWidget); // 1 approval waiting
    await tester.tap(find.textContaining('need'));
    await tester.pumpAndSettle();
    expect(find.text('Delete task "Old"'), findsOneWidget); // Approvals, in Flutter
    expect(e.opened, isEmpty);
  });

  testWidgets('chat streams the reply, shows tools, the model and a switch', (tester) async {
    final e = world();
    await boot(tester, e);
    await tester.tap(find.text('Chats').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Plan my week'));
    await tester.pumpAndSettle();
    expect(find.text('qwen3:8b'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 'Remind me to call Mama');
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();
    expect(e.bodies['POST /conversations/c1/messages'], {'text': 'Remind me to call Mama'});
    expect(find.text('Remind me to call Mama'), findsOneWidget);
    expect(find.textContaining('Create task "Call Mama"'), findsOneWidget);
    expect(find.textContaining('Groq'), findsWidgets); // model chip and the switch notice
    expect(find.text('llama'), findsOneWidget);
    // Private toggle.
    await tester.tap(find.byTooltip('Make this chat private'));
    await tester.pumpAndSettle();
    expect(e.bodies['PATCH /conversations/c1/local-only'], {'local_only': true});
    expect(find.textContaining('Private chat'), findsOneWidget);
  });

  testWidgets('ask bar starts a new chat with the question', (tester) async {
    final e = world();
    await boot(tester, e);
    await tester.enterText(find.byType(TextField).first, 'What should I cook?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(e.calls, contains('POST /conversations'));
    expect(e.bodies['POST /conversations/c2/messages'], {'text': 'What should I cook?'});
  });

  testWidgets('to-dos: views, add and tick off', (tester) async {
    final e = world();
    await boot(tester, e);
    await tester.tap(find.text('To-dos').last);
    await tester.pumpAndSettle();
    expect(find.text('Call Sam'), findsOneWidget);
    expect(find.textContaining('Today'), findsWidgets);
    await tester.tap(find.byType(Checkbox).last);
    await tester.pumpAndSettle();
    expect(e.calls, contains('POST /tasks/t2/complete'));
    await tester.enterText(find.widgetWithText(TextField, 'Add a to-do for today'), 'Order gloves');
    await tester.tap(find.byTooltip('Add'));
    await tester.pumpAndSettle();
    expect((e.bodies['POST /tasks'] as Map)['title'], 'Order gloves');
    expect((e.bodies['POST /tasks'] as Map)['due_at'], isNotNull);
    await tester.tap(find.text('Upcoming'));
    await tester.pumpAndSettle();
    expect(e.calls, contains('GET /tasks?view=upcoming'));
  });

  testWidgets('more opens screens not yet in Flutter, and their back button returns', (tester) async {
    final e = world();
    await boot(tester, e);
    await tester.tap(find.text('Your stuff').last);
    await tester.pumpAndSettle();
    expect(find.text('UGX 45000 this month'), findsOneWidget);
    await tester.tap(find.text('Money'));
    await tester.pumpAndSettle();
    expect(find.text('Spent this month'), findsOneWidget); // Money, in Flutter
    expect(find.text('UGX 45,000'), findsWidgets);
    Navigator.of(tester.element(find.text('Spent this month'))).pop();
    await tester.pumpAndSettle();
    // A page without a Flutter screen opens the engine's web page; its back button returns.
    e.emitOpen('/share');
    await tester.pumpAndSettle();
    expect(e.opened, ['/share']);
    e.emitOpen('back');
    await tester.pumpAndSettle();
    expect(find.text('Money'), findsOneWidget); // back on Your stuff
    // Approvals is a Flutter screen now.
    await tester.tap(find.textContaining('waiting for your approval'));
    await tester.pumpAndSettle();
    expect(find.text('Delete task "Old"'), findsOneWidget);
    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    expect(e.calls, contains('POST /actions/a1/approve'));
    Navigator.of(tester.element(find.text('Approvals').first)).pop();
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.textContaining('remembers'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('remembers'));
    await tester.pumpAndSettle();
    expect(find.text('Prefers short answers'), findsOneWidget);
    e.emitOpen('/tasks');
    await tester.pumpAndSettle();
    expect(find.text('Call Sam'), findsOneWidget);
  });

  testWidgets('first run: the setup screen opens', (tester) async {
    final e = world(onboarded: false);
    await boot(tester, e);
    // Setup is a Flutter screen now; skipping it marks Carino as set up and lands on Home.
    expect(find.text('Hi! Let’s get you set up.'), findsOneWidget);
    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();
    expect(e.bodies['PATCH /settings'], {'onboarded': true});
    expect(find.text('Hi! Let’s get you set up.'), findsNothing);
  });

  testWidgets('settings, apps, connectors, messaging, ramble and access are Flutter screens', (tester) async {
    final e = world();
    e.routes.addAll({
      'GET /apps': (_) => {'apps': [{'id': 'google', 'label': 'Google', 'group': 'google', 'redirect_uri': 'http://127.0.0.1/cb', 'client': null, 'needs_secret': true, 'one_tap': true, 'accounts': [{'id': 'ac1', 'label': 'me@example.com', 'last_error': null}]}]},
      'GET /channels': (_) => {'channels': [], 'transcription': false, 'shared_whatsapp': {'number': '+256 700 000000'}},
      'GET /connectors': (_) => {'connectors': [{'id': 'k1', 'name': 'Notion', 'url': 'https://mcp.notion.com/mcp', 'tools': [], 'enabled': true, 'signed_in': true}]},
      'GET /sync': (_) => {'device': {'name': 'My phone'}, 'peers': [], 'conflicts': []},
      'GET /files': (_) => {'folders': []},
      'GET /models': (_) => {'connections': [{'id': 'groq', 'label': 'Groq', 'status': 'ok', 'billing': 'free', 'models': 2, 'local': false, 'main': true}], 'models': [], 'recommendations': {}},
      'GET /connections': (_) => {'accounts': [], 'connectors': []},
      'GET /usage/summary': (_) => {'today': 0, 'month': 0, 'limits': {'dailyUsd': null, 'monthlyUsd': null}, 'warning': {}, 'byModel': []},
      'GET /device/discover': (_) => {'found': []},
    });
    await boot(tester, e);
    for (final (path, title, text) in [
      ('/apps', 'My apps', 'Gmail'),
      ('/connectors', 'Connected apps', 'Notion'),
      ('/messaging', 'Messaging', 'Link my WhatsApp'),
      ('/ramble', 'Ramble it out', 'Sort it out'),
      ('/access', 'What Carino can reach', 'Notion'),
      ('/settings#devices', 'Devices', 'This device: My phone'),
      ('/connections', 'AI & connections', 'Groq'),
    ]) {
      e.emitOpen(path);
      await tester.pumpAndSettle();
      expect(find.text(title), findsWidgets, reason: path);
      expect(find.textContaining(text), findsWidgets, reason: path);
      expect(e.opened, isNot(contains(path)), reason: '$path should not be a web screen');
      Navigator.of(tester.element(find.text(title).first)).pop();
      await tester.pumpAndSettle();
    }
  });

  test('stream parser handles events split across pieces', () {
    final p = SseParser();
    expect(p.add('event: text\ndata: {"del'), isEmpty);
    final out = p.add('ta":"Hi"}\n\nevent: done\ndata: {}\n\n');
    expect(out.map((e) => e.event), ['text', 'done']);
    expect(out.first.data['delta'], 'Hi');
  });

  test('due labels', () {
    final now = DateTime(2026, 11, 12, 9);
    expect(dueLabel(DateTime(2026, 11, 12, 15, 0), now: now), 'Today 15:00');
    expect(dueLabel(DateTime(2026, 11, 13), allDay: true, now: now), 'Tomorrow');
    expect(dueLabel(DateTime(2026, 11, 21, 9, 30), now: now), 'Sat 21 Nov 09:30');
  });
}
