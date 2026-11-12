import 'package:flutter/material.dart';
import '../l10n.dart';

import '../app_state.dart';
import '../engine/engine.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// "15000", "15k", "1.2m" → a number (null when it isn't one).
num? parseAmount(String v) {
  final m = RegExp(r'^(\d+(?:\.\d+)?)([km]?)$').firstMatch(v.trim().toLowerCase().replaceAll(RegExp(r'[\s,]'), ''));
  if (m == null) return null;
  final n = double.parse(m.group(1)!) * (m.group(2) == 'k' ? 1e3 : m.group(2) == 'm' ? 1e6 : 1);
  if (n <= 0) return null;
  return n == n.roundToDouble() ? n.round() : n;
}

String _day(String? d) {
  final t = DateTime.tryParse('${d ?? ''}T12:00:00');
  if (t == null) return '';
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${t.day} ${mo[t.month - 1]}${t.year == DateTime.now().year ? '' : ' ${t.year}'}';
}

String _monthLabel(String month) {
  const mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  final p = month.split('-');
  return '${mo[int.parse(p[1]) - 1]} ${p[0]}';
}

String _shift(String month, int by) {
  final p = month.split('-').map(int.parse).toList();
  final d = DateTime(p[0], p[1] + by, 1);
  return '${d.year}-${d.month.toString().padLeft(2, '0')}';
}

/// Money: spending and budgets, income, bills, debts and savings — per book (personal, pharmacy…).
class MoneyScreen extends StatefulWidget {
  const MoneyScreen({super.key});
  @override
  State<MoneyScreen> createState() => _MoneyScreenState();
}

class _MoneyScreenState extends State<MoneyScreen> {
  static String? _book; // remembered while the app runs
  String? _month;
  int _bump = 0;

  String get _query => Uri(queryParameters: {'month': ?_month, 'book': ?_book}).query;
  Map<String, dynamic> withBook(Map<String, dynamic> b) => _book == null ? b : {...b, 'book': _book};

  /// Runs a change, shows what happened (duplicates, budget alerts, conflicts), and reloads.
  Future<void> act(Future<dynamic> Function() fn, [String? ok]) async {
    try {
      final res = await fn();
      if (!mounted) return;
      if (ok != null) toast(context, ok);
      if (res is Map && res['possible_duplicate'] != null) toast(context, tr('The same amount was logged a few minutes ago — delete one if it was logged twice.'), error: true);
      for (final a in (res is Map ? (res['alerts'] as List?) ?? const [] : const [])) {
        toast(context, '${(a as Map)['title']}', error: a['level'] == 100);
      }
    } catch (e) {
      if (!mounted) return;
      toast(context, e is ApiError && e.status == 409 ? 'This was changed on another device since you opened it. Check it and try again.' : errorText(e), error: true);
    }
    setState(() => _bump++);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return DefaultTabController(
      length: 5,
      child: Scaffold(
        appBar: AppBar(title: const Tx('Money')),
        body: Loader<Map>(
          reloadKey: '$_bump|$_query',
          load: () async => await app.api.get('/money${_query.isEmpty ? '' : '?$_query'}') as Map,
          builder: (context, d, reload) {
            if (_book != null && d['book'] != _book) WidgetsBinding.instance.addPostFrameCallback((_) => setState(() => _book = null));
            final cur = '${d['currency'] ?? 'USD'}';
            return Column(children: [
              _books(context, d),
              TabBar(isScrollable: true, tabAlignment: TabAlignment.start, tabs: [
                const Tab(text: 'Spending'),
                const Tab(text: 'Income'),
                Tab(text: 'Bills${(d['bills'] as List).isEmpty ? '' : ' (${(d['bills'] as List).length})'}'),
                Tab(text: 'Debts${(d['debts'] as List).isEmpty ? '' : ' (${(d['debts'] as List).length})'}'),
                const Tab(text: 'Savings'),
              ]),
              Expanded(
                child: TabBarView(children: [
                  _Spending(d: d, cur: cur, month: _month, onMonth: (m) => setState(() => _month = m), money: this),
                  _Income(d: d, cur: cur, money: this),
                  _Bills(d: d, cur: cur, money: this),
                  _Debts(d: d, cur: cur, money: this),
                  _Savings(d: d, cur: cur, money: this),
                ]),
              ),
            ]);
          },
        ),
      ),
    );
  }

  Widget _books(BuildContext context, Map d) {
    final books = (d['books'] as List).cast<Map>();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
          for (final b in books)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                avatar: Icon(b['id'] == null ? Icons.person_outline : Icons.work_outline, size: 16),
                label: Text('${b['name']}'),
                selected: b['id'] == d['book'],
                onSelected: (_) => setState(() => _book = b['id'] as String?),
              ),
            ),
          ActionChip(avatar: const Icon(Icons.add, size: 16), label: const Tx('New book'), onPressed: () => _newBook(context)),
        ]),
      ),
      if (d['book'] != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
          child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
            Tx('Kept apart from your personal money. ', style: Theme.of(context).textTheme.bodySmall),
            InkWell(
              onTap: () async {
                final name = books.firstWhere((b) => b['id'] == d['book'], orElse: () => {'name': 'this'})['name'];
                if (!await confirmDialog(context, title: tr('Delete the “{0}” book?', [name]), body: tr('Everything recorded in it is deleted. Personal money isn’t touched.'), confirm: tr('Delete book'), danger: true)) return;
                await act(() => AppState.read(context).api.delete('/money/books/${d['book']}'), 'Book deleted');
                setState(() => _book = null);
              },
              child: Tx('Delete this book', style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.error, decoration: TextDecoration.underline)),
            ),
          ]),
        ),
    ]);
  }

  Future<void> _newBook(BuildContext context) async {
    final name = await _askText(context, title: tr('New money book'), label: tr('Name'), hint: 'e.g. Pharmacy', help: 'A separate book for a business or project: its money is kept apart from your personal money.');
    if (name == null || name.trim().isEmpty || !context.mounted) return;
    try {
      final b = await AppState.read(context).api.post('/money/books', {'name': name.trim()}) as Map;
      setState(() => _book = b['id'] as String?);
      if (context.mounted) toast(context, tr('Book created'));
    } catch (e) {
      if (context.mounted) toast(context, errorText(e), error: true);
    }
  }
}

Future<String?> _askText(BuildContext context, {required String title, required String label, String? hint, String? help, String initial = '', TextInputType? keyboard}) {
  final c = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Tx(title),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(controller: c, autofocus: true, keyboardType: keyboard, decoration: InputDecoration(labelText: tr(label), hintText: hint == null ? null : tr(hint))),
        if (help != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(help, style: Theme.of(ctx).textTheme.bodySmall)),
      ]),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Tx('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Tx('Save'))],
    ),
  );
}

/// A big number with a caption, like the web app's money summary.
class _Summary extends StatelessWidget {
  final String caption;
  final String value;
  final String? sub;
  final String? side;
  final String? sideValue;
  final String? sideSub;
  const _Summary({required this.caption, required this.value, this.sub, this.side, this.sideValue, this.sideSub});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(caption, style: t.bodySmall),
              Text(value, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
              if (sub != null) Text(sub!, style: t.bodySmall),
            ]),
          ),
          if (side != null)
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text(side!, style: t.bodySmall),
              Text(sideValue ?? '', style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700)),
              if (sideSub != null) Text(sideSub!, style: t.bodySmall),
            ]),
        ]),
      ),
    );
  }
}

class _Spending extends StatelessWidget {
  final Map d;
  final String cur;
  final String? month;
  final ValueChanged<String?> onMonth;
  final _MoneyScreenState money;
  const _Spending({required this.d, required this.cur, required this.month, required this.onMonth, required this.money});

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final shown = month ?? '${d['month']}';
    final isCurrent = d['month'] == '${d['today']}'.substring(0, 7);
    final cats = (d['categories'] as List).cast<Map>();
    String label(String id) => id == 'total' ? 'Everything' : '${cats.firstWhere((c) => c['id'] == id, orElse: () => {'label': id})['label']}';
    final week = (d['week'] as Map?) ?? const {};
    final budgets = (d['budgets'] as List).cast<Map>();
    final byCat = (d['byCategory'] as List).cast<Map>();
    final maxCat = byCat.fold<num>(1, (a, c) => (c['total'] as num) > a ? c['total'] as num : a);
    final groups = <String, List<Map>>{};
    for (final e in (d['expenses'] as List).cast<Map>()) {
      groups.putIfAbsent('${e['spent_on']}', () => []).add(e);
    }
    final t = Theme.of(context).textTheme;
    final cs = Theme.of(context).colorScheme;
    final other = (d['other'] as List? ?? const []).cast<Map>();
    return ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
      Row(children: [
        IconButton(tooltip: tr('Previous month'), onPressed: () => onMonth(_shift(shown, -1)), icon: const Icon(Icons.chevron_left)),
        Expanded(child: Text(_monthLabel(shown), textAlign: TextAlign.center, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w700))),
        IconButton(tooltip: tr('Next month'), onPressed: isCurrent ? null : () => onMonth(_shift(shown, 1)), icon: const Icon(Icons.chevron_right)),
      ]),
      _Summary(
        caption: isCurrent ? 'Spent this month' : 'Spent', value: moneyText(d['total'], cur),
        sub: [
          '${d['count']} purchase${d['count'] == 1 ? '' : 's'}${other.isEmpty ? '' : ' · plus ${other.map((o) => moneyText(o['total'], '${o['currency']}')).join(', ')}'}',
          if ((d['income'] as num? ?? 0) > 0) '${moneyText(d['income'], cur)} came in · ${moneyText(d['net'], cur)} ${(d['net'] as num) < 0 ? 'more out than in' : 'left over'}',
        ].join('\n'),
        side: isCurrent ? 'Last 7 days' : null, sideValue: moneyText(week['total'], cur),
        sideSub: (week['previous'] as num? ?? 0) > 0 ? '${(week['total'] as num) > (week['previous'] as num) ? 'Up' : (week['total'] as num) < (week['previous'] as num) ? 'Down' : 'Same'} from ${moneyText(week['previous'], cur)}' : null,
      ),
      if (isCurrent) ...[const SizedBox(height: 10), _AddExpense(cats: cats, cur: cur, today: '${d['today']}', onAdd: (body) => money.act(() => api.post('/expenses', money.withBook(body)), 'Logged'))],
      const SizedBox(height: 10),
      Section(
        title: tr('Monthly budgets'),
        action: TextButton.icon(onPressed: () => _editBudget(context, cats, null), icon: const Icon(Icons.add, size: 18), label: const Tx('Add')),
        child: budgets.isEmpty
            ? Tx('Set a limit for a month — for everything, or just eating out — and Carino warns you at 80% and if you go over.', style: t.bodySmall)
            : Column(children: [
                for (final b in budgets)
                  InkWell(
                    onTap: () => _editBudget(context, cats, b),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [Expanded(child: Text('${b['label']}', style: const TextStyle(fontWeight: FontWeight.w600))), Text('${moneyText(b['spent'], '${b['currency']}')} of ${moneyText(b['amount'], '${b['currency']}')}', style: t.bodySmall)]),
                        const SizedBox(height: 4),
                        LinearProgressIndicator(
                          value: ((b['percent'] as num) / 100).clamp(0, 1).toDouble(),
                          color: (b['spent'] as num) > (b['amount'] as num) ? cs.error : (b['percent'] as num) >= 80 ? Colors.orange : cs.primary,
                          borderRadius: BorderRadius.circular(9),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${(b['spent'] as num) > (b['amount'] as num) ? '${moneyText((b['spent'] as num) - (b['amount'] as num), '${b['currency']}')} over' : '${moneyText(b['left'], '${b['currency']}')} left'}'
                          '${b['perDayLeft'] != null && (b['perDayLeft'] as num) > 0 ? ' · about ${moneyText((b['perDayLeft'] as num).floor(), '${b['currency']}')} a day for ${d['daysLeft']} days' : ''}',
                          style: t.bodySmall,
                        ),
                      ]),
                    ),
                  ),
              ]),
      ),
      if (byCat.isNotEmpty) ...[
        const SizedBox(height: 10),
        Section(
          title: tr('Where it went'),
          child: Column(children: [
            for (final c in byCat)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(children: [
                  SizedBox(width: 96, child: Text('${c['label']}', style: t.bodySmall, overflow: TextOverflow.ellipsis)),
                  Expanded(child: LinearProgressIndicator(value: ((c['total'] as num) / maxCat).toDouble(), minHeight: 10, borderRadius: BorderRadius.circular(9))),
                  SizedBox(width: 96, child: Text(moneyText(c['total'], cur), textAlign: TextAlign.right, style: t.bodySmall)),
                ]),
              ),
          ]),
        ),
      ],
      const SizedBox(height: 10),
      Section(
        title: tr('Spending'),
        action: TextButton.icon(onPressed: () => openPath(context, '/chat/new?q=${Uri.encodeQueryComponent('Please log this receipt')}'), icon: const Icon(Icons.receipt_long, size: 18), label: const Tx('Receipt')),
        child: groups.isEmpty
            ? EmptyView(icon: Icons.account_balance_wallet_outlined, title: isCurrent ? 'Nothing logged this month' : 'Nothing logged that month', body: tr('Add one above, or tell Carino what you spent.'))
            : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                for (final g in groups.entries) ...[
                  Padding(padding: const EdgeInsets.only(top: 8, bottom: 2), child: Text(g.key == d['today'] ? 'Today' : _day(g.key), style: t.labelMedium?.copyWith(color: cs.onSurfaceVariant))),
                  for (final e in g.value)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      title: Text('${(e['note'] ?? '').toString().isNotEmpty ? e['note'] : (e['merchant'] ?? label('${e['category']}'))}'),
                      subtitle: Text('${label('${e['category']}')}${e['merchant'] != null && (e['note'] ?? '').toString().isNotEmpty ? ' · ${e['merchant']}' : ''}${e['source'] == 'receipt' ? ' · from a receipt' : e['source'] == 'bill' ? ' · bill' : ''}'),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        Text(moneyText(e['amount'], '${e['currency']}'), style: const TextStyle(fontWeight: FontWeight.w700)),
                        PopupMenuButton<String>(
                          tooltip: tr('Edit or delete'),
                          onSelected: (v) async {
                            if (v == 'edit') return _editExpense(context, e, cats, '${d['today']}');
                            if (!await confirmDialog(context, title: tr('Delete this expense?'), body: '${moneyText(e['amount'], '${e['currency']}')}${e['note'] != null ? ' · ${e['note']}' : ''}', confirm: tr('Delete'), danger: true)) return;
                            await money.act(() => api.delete('/expenses/${e['id']}'), 'Deleted');
                          },
                          itemBuilder: (_) => const [PopupMenuItem(value: 'edit', child: Tx('Edit')), PopupMenuItem(value: 'delete', child: Tx('Delete'))],
                        ),
                      ]),
                      onTap: () => _editExpense(context, e, cats, '${d['today']}'),
                    ),
                ],
              ]),
      ),
      const SizedBox(height: 10),
      Row(children: [
        Tx('Amounts are in {0}. ', args: [cur], style: t.bodySmall),
        TextButton(
          onPressed: () async {
            final c = await _askText(context, title: tr('Your currency'), label: tr('3-letter code'), hint: 'UGX', initial: cur, help: 'Empty uses your region. Spending already logged keeps its currency.');
            if (c == null) return;
            final code = c.trim().toUpperCase();
            if (code.isNotEmpty && !RegExp(r'^[A-Z]{3}$').hasMatch(code)) {
              if (context.mounted) toast(context, tr('Use a 3-letter code like UGX, KES or USD'), error: true);
              return;
            }
            await money.act(() => api.patch('/settings', {'money': {'currency': code}}), 'Currency saved');
          },
          child: const Tx('Change currency'),
        ),
      ]),
    ]);
  }

  Future<void> _editBudget(BuildContext context, List<Map> cats, Map? b) async {
    final api = AppState.read(context).api;
    String category = '${b?['category'] ?? 'total'}';
    final amount = TextEditingController(text: b == null ? '' : '${b['amount']}');
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Tx('Monthly budget'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<String>(
              initialValue: category,
              decoration: InputDecoration(labelText: tr('For')),
              items: [const DropdownMenuItem(value: 'total', child: Tx('Everything')), for (final c in cats) DropdownMenuItem(value: '${c['id']}', child: Text('${c['label']}'))],
              onChanged: (v) => set(() => category = v ?? 'total'),
            ),
            const SizedBox(height: 10),
            TextField(controller: amount, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: tr('Per month ({0})', [cur]), hintText: tr('e.g. 300k'), helperText: tr('Leave empty to remove this budget.'))),
          ]),
          actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Tx('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Tx('Save'))],
        ),
      ),
    );
    if (ok != true || !context.mounted) return;
    final n = amount.text.trim().isEmpty ? 0 : parseAmount(amount.text);
    if (n == null) return toast(context, tr('Enter an amount, e.g. 300000 or 300k'), error: true);
    await money.act(() => api.put('/budgets', money.withBook({'category': category, 'amount': n})), n == 0 ? 'Budget removed' : 'Budget saved');
  }

  Future<void> _editExpense(BuildContext context, Map e, List<Map> cats, String today) async {
    final api = AppState.read(context).api;
    final changes = await showModalBottomSheet<Map<String, dynamic>>(context: context, isScrollControlled: true, useSafeArea: true, builder: (_) => _ExpenseForm(e: e, cats: cats, today: today));
    if (changes == null || changes.isEmpty) return;
    // Only what changed is sent, with the version it was based on: a change made on another
    // device meanwhile comes back as a conflict to check, not an overwrite.
    await money.act(() => api.patch('/expenses/${e['id']}', changes, headers: {if (e['updated_at'] != null) 'x-base-version': '${e['updated_at']}'}), 'Saved');
  }
}

String moneyText(Object? amount, String cur) => money(amount is num ? amount : num.tryParse('$amount') ?? 0, cur);

class _AddExpense extends StatefulWidget {
  final List<Map> cats;
  final String cur;
  final String today;
  final Future<void> Function(Map<String, dynamic>) onAdd;
  const _AddExpense({required this.cats, required this.cur, required this.today, required this.onAdd});
  @override
  State<_AddExpense> createState() => _AddExpenseState();
}

class _AddExpenseState extends State<_AddExpense> {
  final _amount = TextEditingController();
  final _note = TextEditingController();
  String _cat = 'food';
  late String _day = widget.today;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final cats = widget.cats;
    if (!cats.any((c) => c['id'] == _cat) && cats.isNotEmpty) _cat = '${cats.first['id']}';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(children: [
          Row(children: [
            Expanded(child: TextField(controller: _amount, keyboardType: TextInputType.number, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: tr('Amount ({0})', [widget.cur]), hintText: '15k', isDense: true))),
            const SizedBox(width: 10),
            Expanded(
              child: DropdownButtonFormField<String>(
                initialValue: _cat,
                isExpanded: true,
                decoration: InputDecoration(labelText: tr('For'), isDense: true),
                items: [for (final c in cats) DropdownMenuItem(value: '${c['id']}', child: Text('${c['label']}', overflow: TextOverflow.ellipsis))],
                onChanged: (v) => setState(() => _cat = v ?? _cat),
              ),
            ),
          ]),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: TextField(controller: _note, decoration: InputDecoration(labelText: tr('Note'), hintText: tr('Lunch with Sam'), isDense: true))),
            const SizedBox(width: 8),
            ActionChip(
              avatar: const Icon(Icons.event, size: 16),
              label: Text(_day == widget.today ? 'Today' : _day.substring(5)),
              onPressed: () async {
                final t = DateTime.parse(widget.today);
                final p = await showDatePicker(context: context, firstDate: DateTime(t.year - 5), lastDate: t, initialDate: DateTime.parse(_day));
                if (p != null) setState(() => _day = '${p.year}-${p.month.toString().padLeft(2, '0')}-${p.day.toString().padLeft(2, '0')}');
              },
            ),
          ]),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _busy || _amount.text.trim().isEmpty
                  ? null
                  : () async {
                      final n = parseAmount(_amount.text);
                      if (n == null) return toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
                      setState(() => _busy = true);
                      await widget.onAdd({'amount': n, 'category': _cat, if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(), 'spent_on': _day});
                      if (!mounted) return;
                      setState(() { _busy = false; _amount.clear(); _note.clear(); _day = widget.today; });
                    },
              icon: const Icon(Icons.add),
              label: const Tx('Add'),
            ),
          ),
        ]),
      ),
    );
  }
}

class _ExpenseForm extends StatefulWidget {
  final Map e;
  final List<Map> cats;
  final String today;
  const _ExpenseForm({required this.e, required this.cats, required this.today});
  @override
  State<_ExpenseForm> createState() => _ExpenseFormState();
}

class _ExpenseFormState extends State<_ExpenseForm> {
  late final _amount = TextEditingController(text: '${widget.e['amount']}');
  late final _note = TextEditingController(text: '${widget.e['note'] ?? ''}');
  late final _merchant = TextEditingController(text: '${widget.e['merchant'] ?? ''}');
  late String _cat = '${widget.e['category']}';
  late String _day = '${widget.e['spent_on']}';

  @override
  Widget build(BuildContext context) {
    final e = widget.e;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Tx('Edit spending', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        TextField(controller: _amount, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: tr('Amount ({0})', [e['currency']]))),
        const SizedBox(height: 10),
        DropdownButtonFormField<String>(initialValue: widget.cats.any((c) => c['id'] == _cat) ? _cat : null, decoration: InputDecoration(labelText: tr('For')), items: [for (final c in widget.cats) DropdownMenuItem(value: '${c['id']}', child: Text('${c['label']}'))], onChanged: (v) => setState(() => _cat = v ?? _cat)),
        const SizedBox(height: 10),
        TextField(controller: _note, decoration: InputDecoration(labelText: tr('Note'))),
        const SizedBox(height: 10),
        TextField(controller: _merchant, decoration: InputDecoration(labelText: tr('Shop or person'))),
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Tx('Day'),
          trailing: Text(_day),
          onTap: () async {
            final t = DateTime.parse(widget.today);
            final p = await showDatePicker(context: context, firstDate: DateTime(t.year - 5), lastDate: t, initialDate: DateTime.tryParse(_day) ?? t);
            if (p != null) setState(() => _day = '${p.year}-${p.month.toString().padLeft(2, '0')}-${p.day.toString().padLeft(2, '0')}');
          },
        ),
        if (e['source'] == 'receipt') Tx('Logged from a receipt photo. That stays recorded when you edit it.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 10),
        FilledButton(
          onPressed: () {
            final n = parseAmount(_amount.text);
            if (n == null) return toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
            final changes = <String, dynamic>{
              if (n != e['amount']) 'amount': n,
              if (_cat != e['category']) 'category': _cat,
              if (_note.text.trim() != (e['note'] ?? '')) 'note': _note.text.trim(),
              if (_merchant.text.trim() != (e['merchant'] ?? '')) 'merchant': _merchant.text.trim(),
              if (_day != e['spent_on']) 'spent_on': _day,
            };
            Navigator.pop(context, changes);
          },
          child: const Tx('Save'),
        ),
      ]),
    );
  }
}

/// A small form: fields, then a button. Amount fields accept "15k".
class _QuickForm extends StatefulWidget {
  final String label;
  final List<(String name, String label, String kind, String? hint, List<(String, String)>? options, bool required)> fields;
  final Future<bool> Function(Map<String, String> v) onSubmit;
  const _QuickForm({required this.label, required this.fields, required this.onSubmit});
  @override
  State<_QuickForm> createState() => _QuickFormState();
}

class _QuickFormState extends State<_QuickForm> {
  late Map<String, String> _v = _empty();
  late final Map<String, TextEditingController> _c = {for (final f in widget.fields) if (f.$5 == null && f.$3 != 'date') f.$1: TextEditingController()};
  bool _busy = false;

  Map<String, String> _empty() => {for (final f in widget.fields) f.$1: f.$5?.first.$1 ?? ''};

  @override
  Widget build(BuildContext context) {
    final ready = widget.fields.every((f) => !f.$6 || (_c[f.$1]?.text ?? _v[f.$1] ?? '').trim().isNotEmpty);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(children: [
          for (final f in widget.fields)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: f.$5 != null
                  ? DropdownButtonFormField<String>(initialValue: _v[f.$1], decoration: InputDecoration(labelText: f.$2, isDense: true), items: [for (final o in f.$5!) DropdownMenuItem(value: o.$1, child: Text(o.$2))], onChanged: (x) => setState(() => _v[f.$1] = x ?? ''))
                  : f.$3 == 'date'
                      ? ListTile(
                          contentPadding: EdgeInsets.zero,
                          dense: true,
                          title: Text(f.$2),
                          trailing: Text((_v[f.$1] ?? '').isEmpty ? 'Choose' : _v[f.$1]!),
                          onTap: () async {
                            final p = await showDatePicker(context: context, firstDate: DateTime(2000), lastDate: DateTime(2100), initialDate: DateTime.now());
                            if (p != null) setState(() => _v[f.$1] = '${p.year}-${p.month.toString().padLeft(2, '0')}-${p.day.toString().padLeft(2, '0')}');
                          },
                        )
                      : TextField(controller: _c[f.$1], onChanged: (_) => setState(() {}), keyboardType: f.$3 == 'amount' ? TextInputType.number : null, decoration: InputDecoration(labelText: f.$2, hintText: f.$4, isDense: true)),
            ),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _busy || !ready
                  ? null
                  : () async {
                      setState(() => _busy = true);
                      final ok = await widget.onSubmit({..._v, for (final e in _c.entries) e.key: e.value.text});
                      if (!mounted) return;
                      setState(() {
                        _busy = false;
                        if (ok) {
                          _v = _empty();
                          for (final c in _c.values) {
                            c.clear();
                          }
                        }
                      });
                    },
              icon: const Icon(Icons.add),
              label: Tx(widget.label),
            ),
          ),
        ]),
      ),
    );
  }
}

class _Income extends StatelessWidget {
  final Map d;
  final String cur;
  final _MoneyScreenState money;
  const _Income({required this.d, required this.cur, required this.money});

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final list = (d['income_list'] as List? ?? const []).cast<Map>();
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
      _Summary(caption: 'Came in this month', value: moneyText(d['income'], cur), sub: 'Spent ${moneyText(d['total'], cur)} · ${moneyText(d['net'], cur)} ${(d['net'] as num) < 0 ? 'more out than in' : 'left over'}'),
      const SizedBox(height: 10),
      _QuickForm(
        label: tr('Add income'),
        fields: [('amount', 'Amount ($cur)', 'amount', '200k', null, true), ('source', 'From', 'text', 'Salary, sales…', null, false), ('received_on', 'Day', 'date', null, null, false)],
        onSubmit: (v) async {
          final n = parseAmount(v['amount']!);
          if (n == null) {
            toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
            return false;
          }
          await money.act(() => api.post('/income', money.withBook({'amount': n, if (v['source']!.isNotEmpty) 'source': v['source'], if (v['received_on']!.isNotEmpty) 'received_on': v['received_on']})), 'Income recorded');
          return true;
        },
      ),
      const SizedBox(height: 10),
      Section(
        title: tr('This month'),
        child: list.isEmpty
            ? EmptyView(icon: Icons.account_balance_wallet_outlined, title: tr('Nothing recorded yet'), body: tr('Add it above, or tell Carino: “got paid 1.2m salary”.'))
            : Column(children: [
                for (final i in list)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('${i['source'] ?? i['note'] ?? 'Income'}'),
                    subtitle: Text(_day('${i['received_on']}')),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(moneyText(i['amount'], '${i['currency']}'), style: const TextStyle(fontWeight: FontWeight.w700)),
                      IconButton(tooltip: tr('Delete'), icon: const Icon(Icons.delete_outline), onPressed: () => money.act(() => api.delete('/income/${i['id']}'), 'Deleted')),
                    ]),
                  ),
              ]),
      ),
    ]);
  }
}

class _Bills extends StatelessWidget {
  final Map d;
  final String cur;
  final _MoneyScreenState money;
  const _Bills({required this.d, required this.cur, required this.money});

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final bills = (d['bills'] as List).cast<Map>();
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
      _QuickForm(
        label: tr('Add bill'),
        fields: [
          ('name', 'Bill', 'text', 'Rent, school fees…', null, true),
          ('amount', 'Amount ($cur)', 'amount', '600k', null, true),
          ('repeat', 'Repeats', 'text', null, const [('monthly', 'Every month'), ('weekly', 'Every week'), ('yearly', 'Every year')], false),
          ('next_due', 'Next due', 'date', null, null, true),
        ],
        onSubmit: (v) async {
          final n = parseAmount(v['amount']!);
          if (n == null || v['next_due']!.isEmpty) {
            toast(context, n == null ? 'Enter an amount, e.g. 15000 or 15k' : 'Choose when it’s next due', error: true);
            return false;
          }
          await money.act(() => api.post('/bills', money.withBook({'name': v['name']!.trim(), 'amount': n, 'repeat': v['repeat'], 'next_due': v['next_due']})), 'Bill added — Carino reminds you on the due day');
          return true;
        },
      ),
      const SizedBox(height: 10),
      Section(
        title: tr('Coming up'),
        child: bills.isEmpty
            ? EmptyView(icon: Icons.event_outlined, title: tr('No bills yet'), body: tr('Add rent, school fees or subscriptions and Carino reminds you when they’re due.'))
            : Column(children: [
                for (final b in bills)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('${b['name']}'),
                    subtitle: Text(
                      '${'${b['next_due']}'.compareTo('${d['today']}') < 0 ? 'Overdue since' : 'Due'} ${_day('${b['next_due']}')} · ${b['repeat']}${b['last_paid_on'] != null ? ' · last paid ${_day('${b['last_paid_on']}')}' : ''}',
                      style: TextStyle(color: '${b['next_due']}'.compareTo('${d['today']}') < 0 ? Theme.of(context).colorScheme.error : null),
                    ),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(moneyText(b['amount'], '${b['currency']}'), style: const TextStyle(fontWeight: FontWeight.w700)),
                      const SizedBox(width: 6),
                      FilledButton.tonal(onPressed: () => money.act(() => api.post('/bills/${b['id']}/pay', {}), 'Paid'), child: const Tx('Paid')),
                      IconButton(
                        tooltip: tr('Stop {0}', [b['name']]),
                        icon: const Icon(Icons.close),
                        onPressed: () async {
                          if (await confirmDialog(context, title: tr('Stop the “{0}” bill?', [b['name']]), body: tr('Its reminder stops too. Past payments stay in your spending.'), confirm: tr('Stop'))) {
                            await money.act(() => api.delete('/bills/${b['id']}'), 'Bill stopped');
                          }
                        },
                      ),
                    ]),
                  ),
              ]),
      ),
    ]);
  }
}

class _Debts extends StatelessWidget {
  final Map d;
  final String cur;
  final _MoneyScreenState money;
  const _Debts({required this.d, required this.cur, required this.money});

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final debts = (d['debts'] as List).cast<Map>();
    num sum(String dir) => debts.where((x) => x['direction'] == dir && x['currency'] == cur).fold<num>(0, (a, x) => a + (x['left'] as num));
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
      _Summary(caption: 'You owe', value: moneyText(sum('i_owe'), cur), side: 'Owed to you', sideValue: moneyText(sum('owed_to_me'), cur)),
      const SizedBox(height: 10),
      _QuickForm(
        label: tr('Add'),
        fields: [
          ('direction', 'Which way', 'text', null, const [('i_owe', 'I owe'), ('owed_to_me', 'Owes me')], false),
          ('person', 'Person', 'text', 'Name', null, true),
          ('amount', 'Amount ($cur)', 'amount', '50k', null, true),
          ('due_on', 'Due (optional)', 'date', null, null, false),
        ],
        onSubmit: (v) async {
          final n = parseAmount(v['amount']!);
          if (n == null) {
            toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
            return false;
          }
          await money.act(() => api.post('/debts', money.withBook({'direction': v['direction'], 'person': v['person']!.trim(), 'amount': n, if (v['due_on']!.isNotEmpty) 'due_on': v['due_on']})), 'Recorded');
          return true;
        },
      ),
      const SizedBox(height: 10),
      Section(
        title: tr('Open'),
        child: debts.isEmpty
            ? EmptyView(icon: Icons.person_outline, title: tr('Nothing owed'), body: tr('Record money lent or borrowed, and payments as they come.'))
            : Column(children: [
                for (final x in debts)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(x['direction'] == 'i_owe' ? 'You owe ${x['person']}' : '${x['person']} owes you'),
                    subtitle: Text('${(x['paid'] as num? ?? 0) > 0 ? '${moneyText(x['paid'], '${x['currency']}')} paid of ${moneyText(x['amount'], '${x['currency']}')}' : 'Since ${_day('${x['created_at']}'.substring(0, 10))}'}${x['due_on'] != null ? ' · due ${_day('${x['due_on']}')}' : ''}'),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      Text(moneyText(x['left'], '${x['currency']}'), style: const TextStyle(fontWeight: FontWeight.w700)),
                      const SizedBox(width: 6),
                      FilledButton.tonal(
                        onPressed: () async {
                          final a = await _askText(context, title: tr('Payment'), label: tr('Amount paid'), initial: '${x['left']}', keyboard: TextInputType.number);
                          if (a == null) return;
                          final n = parseAmount(a);
                          if (n == null) {
                            if (context.mounted) toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
                            return;
                          }
                          await money.act(() => api.post('/debts/${x['id']}/pay', {'amount': n}), 'Payment recorded');
                        },
                        child: const Tx('Payment'),
                      ),
                    ]),
                  ),
              ]),
      ),
    ]);
  }
}

class _Savings extends StatelessWidget {
  final Map d;
  final String cur;
  final _MoneyScreenState money;
  const _Savings({required this.d, required this.cur, required this.money});

  @override
  Widget build(BuildContext context) {
    final api = AppState.read(context).api;
    final goals = (d['goals'] as List? ?? const []).cast<Map>();
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 32), children: [
      _QuickForm(
        label: tr('Add goal'),
        fields: [('name', 'Saving for', 'text', 'Laptop, school fees…', null, true), ('target', 'Target ($cur)', 'amount', '2m', null, true), ('deadline', 'By (optional)', 'date', null, null, false)],
        onSubmit: (v) async {
          final n = parseAmount(v['target']!);
          if (n == null) {
            toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
            return false;
          }
          await money.act(() => api.post('/savings', money.withBook({'name': v['name']!.trim(), 'target': n, if (v['deadline']!.isNotEmpty) 'deadline': v['deadline']})), 'Goal added');
          return true;
        },
      ),
      const SizedBox(height: 10),
      Section(
        title: tr('Goals'),
        child: goals.isEmpty
            ? EmptyView(icon: Icons.track_changes, title: tr('No goals yet'), body: tr('Set something to save for, and add to it as you go.'))
            : Column(children: [
                for (final g in goals)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(child: Text('${g['name']}${g['status'] == 'reached' ? ' ✓' : ''}', style: const TextStyle(fontWeight: FontWeight.w600))),
                        Text('${moneyText(g['saved'], '${g['currency']}')} of ${moneyText(g['target'], '${g['currency']}')}', style: Theme.of(context).textTheme.bodySmall),
                      ]),
                      const SizedBox(height: 4),
                      LinearProgressIndicator(value: ((g['percent'] as num) / 100).clamp(0, 1).toDouble(), borderRadius: BorderRadius.circular(9)),
                      Row(children: [
                        Expanded(child: Text(g['deadline'] != null ? 'By ${_day('${g['deadline']}')}' : '', style: Theme.of(context).textTheme.bodySmall)),
                        TextButton(
                          onPressed: () async {
                            final a = await _askText(context, title: tr('Add or take out'), label: tr('Amount'), hint: '+50k or -10k', help: 'Start with - to take money out.');
                            if (a == null) return;
                            final neg = a.trim().startsWith('-');
                            final n = parseAmount(a.trim().replaceFirst(RegExp(r'^[+-]'), ''));
                            if (n == null) {
                              if (context.mounted) toast(context, tr('Enter an amount, e.g. 15000 or 15k'), error: true);
                              return;
                            }
                            await money.act(() => api.post('/savings/${g['id']}/move', {'amount': neg ? -n : n}), neg ? 'Taken out' : 'Added');
                          },
                          child: const Tx('Add money'),
                        ),
                      ]),
                    ]),
                  ),
              ]),
      ),
    ]);
  }
}
