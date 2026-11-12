import 'package:flutter/material.dart';

/// A titled card section, like the web app's "card pad".
class Section extends StatelessWidget {
  final String? title;
  final String? subtitle;
  final Widget? action;
  final Widget child;
  final EdgeInsets padding;
  const Section({super.key, this.title, this.subtitle, this.action, required this.child, this.padding = const EdgeInsets.all(16)});

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      child: Padding(
        padding: padding,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (title != null)
            Row(children: [
              Expanded(child: Text(title!, style: t.titleMedium?.copyWith(fontWeight: FontWeight.w600))),
              ?action,
            ]),
          if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(subtitle!, style: t.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant))),
          if (title != null || subtitle != null) const SizedBox(height: 10),
          child,
        ]),
      ),
    );
  }
}

class EmptyView extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;
  const EmptyView({super.key, required this.icon, required this.title, this.body, this.action});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        CircleAvatar(radius: 26, backgroundColor: cs.primaryContainer, child: Icon(icon, color: cs.onPrimaryContainer)),
        const SizedBox(height: 12),
        Text(title, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
        if (body != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(body!, textAlign: TextAlign.center, style: TextStyle(color: cs.onSurfaceVariant))),
        if (action != null) Padding(padding: const EdgeInsets.only(top: 12), child: action),
      ]),
    );
  }
}

/// A small coloured label.
class Pill extends StatelessWidget {
  final String text;
  final Color? color;
  const Pill(this.text, {super.key, this.color});

  @override
  Widget build(BuildContext context) {
    final c = color ?? Theme.of(context).colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(99)),
      child: Text(text, style: TextStyle(fontSize: 11.5, color: c, fontWeight: FontWeight.w600)),
    );
  }
}

/// Asks before doing something; true when confirmed.
Future<bool> confirmDialog(BuildContext context, {required String title, String? body, String confirm = 'OK', bool danger = false}) async {
  final cs = Theme.of(context).colorScheme;
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: body == null ? null : Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: cs.error, foregroundColor: cs.onError) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(confirm),
        ),
      ],
    ),
  );
  return ok == true;
}

/// "Fri 21 Nov, 15:00" in the device's time zone.
String fmtDateTime(String? iso, {bool time = true, bool year = false}) {
  final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (d == null) return '';
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  final date = '${wd[d.weekday - 1]} ${d.day} ${mo[d.month - 1]}${year ? ' ${d.year}' : ''}';
  return time ? '$date, ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}' : date;
}

/// "UGX 45,000", "USD 12.50".
String money(num? amount, String? currency) {
  final a = amount ?? 0;
  final whole = a == a.roundToDouble() || a.abs() >= 1000;
  final s = (whole ? a.round().toString() : a.toStringAsFixed(2));
  final parts = s.split('.');
  final digits = parts[0].replaceAll('-', '');
  final b = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) b.write(',');
    b.write(digits[i]);
  }
  return '${currency ?? ''} ${a < 0 ? '-' : ''}$b${parts.length > 1 ? '.${parts[1]}' : ''}'.trim();
}
