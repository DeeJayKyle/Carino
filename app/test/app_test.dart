import 'package:carino/app_state.dart';
import 'package:carino/engine/engine.dart';
import 'package:carino/main.dart';
import 'package:carino/screens/tasks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_engine.dart';

FakeEngine world({bool onboarded = true}) {
  final tasks = [
    {'id': 't1', 'title': 'Buy paracetamol stock', 'status': 'open', 'priority': 2, 'due_at': DateTime.now().add(const Duration(hours: 2)).toUtc().toIso8601String(), 'all_day': false},
    {'id': 't2', 'title': 'Call Sam', 'status': 'open', 'priority': 3, 'due_at': null},
  ];
  final e = FakeEngine(routes: {
    'GET /auth/me': (_) => me(onboarded: onboarded),
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
    expect(e.opened, ['/actions']);
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
    await tester.tap(find.text('More').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Money'));
    await tester.pumpAndSettle();
    expect(e.opened, ['/money']);
    e.emitOpen('back');
    await tester.pumpAndSettle();
    expect(find.text('Money'), findsOneWidget); // back on More
    e.emitOpen('/tasks');
    await tester.pumpAndSettle();
    expect(find.text('Call Sam'), findsOneWidget);
  });

  testWidgets('first run: the setup screen opens', (tester) async {
    final e = world(onboarded: false);
    await boot(tester, e);
    expect(e.opened, ['/']);
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
