import 'package:flutter/material.dart';

import '../app_state.dart';
import '../engine/device.dart';
import '../engine/engine.dart';
import '../nav.dart';
import '../widgets/common.dart';
import '../widgets/files.dart';
import '../widgets/ui.dart';
import '../update/update_ui.dart';
import 'settings_ai.dart';
import 'settings_devices.dart';
import 'access.dart';

/// Saves a settings change and says so.
Future<void> saveSettings(BuildContext context, Map<String, dynamic> patch, [String msg = 'Saved']) async {
  final app = AppState.read(context);
  try {
    await app.api.patch('/settings', patch);
    await app.loadMe();
    if (context.mounted) toast(context, msg);
  } catch (e) {
    if (context.mounted) toast(context, errorText(e), error: true);
  }
}

const settingsSections = <(String, String, IconData, Widget Function())>[
  ('profile', 'Profile & assistant', Icons.person_outline, ProfileSettings.new),
  ('ai', 'AI service', Icons.auto_awesome_outlined, AiSettings.new),
  ('memory', 'Memory', Icons.psychology_outlined, MemorySettings.new),
  ('permissions', 'Permissions', Icons.shield_outlined, PermissionSettings.new),
  ('access', 'What Carino can reach', Icons.visibility_outlined, AccessScreen.new),
  ('notifications', 'Notifications & routines', Icons.notifications_none, NotificationSettings.new),
  ('appearance', 'Appearance & accessibility', Icons.wb_sunny_outlined, AppearanceSettings.new),
  ('regional', 'Language & region', Icons.public, RegionalSettings.new),
  ('voice', 'Voice', Icons.mic_none, VoiceSettings.new),
  ('devices', 'Devices', Icons.phone_iphone, DevicesSettings.new),
  ('privacy', 'Privacy, data & backup', Icons.lock_outline, PrivacySettings.new),
  ('updates', 'Updates', Icons.system_update_outlined, UpdateSettings.new),
];

/// Settings: one page per section (the web app's #sections open straight to theirs).
class SettingsScreen extends StatelessWidget {
  final String? section;
  const SettingsScreen({super.key, this.section});

  @override
  Widget build(BuildContext context) {
    final direct = settingsSections.where((s) => s.$1 == section).firstOrNull;
    if (direct != null) return direct.$4();
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(children: [
        for (final (_, label, icon, page) in settingsSections)
          ListTile(leading: Icon(icon), title: Text(label), trailing: const Icon(Icons.chevron_right), onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page()))),
      ]),
    );
  }
}

/// A settings page with a title and rows.
class SettingsPage extends StatelessWidget {
  final String title;
  final String? intro;
  final List<Widget> children;
  const SettingsPage({super.key, required this.title, this.intro, required this.children});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 32), children: [
          if (intro != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(intro!, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant))),
          ...children,
        ]),
      );
}

class ProfileSettings extends StatefulWidget {
  const ProfileSettings({super.key});
  @override
  State<ProfileSettings> createState() => _ProfileSettingsState();
}

class _ProfileSettingsState extends State<ProfileSettings> {
  Map get p => (AppState.read(context).settings['profile'] as Map?) ?? const {};
  late final _name = TextEditingController(text: '${p['displayName'] ?? ''}');
  late final _assistant = TextEditingController(text: '${p['assistantName'] ?? 'Carino'}');
  late final _lang = TextEditingController(text: '${p['replyLanguage'] ?? ''}');
  late final _instr = TextEditingController(text: '${p['customInstructions'] ?? ''}');
  late String _style = '${p['assistantStyle'] ?? 'balanced'}';
  bool _learning = false;

  /// Learns how the user writes; asks for a few samples when there is too little to go on.
  Future<void> _learn([String? samples]) async {
    final app = AppState.read(context);
    setState(() => _learning = true);
    try {
      await app.api.post('/settings/voice/learn', {'samples': ?samples});
      await app.loadMe();
      if (!mounted) return;
      setState(() => _style = 'mine');
      toast(context, 'Got it — drafts will sound like you.');
    } catch (e) {
      if (!mounted) return;
      if (samples == null && e is ApiError && e.status == 400) {
        final c = TextEditingController();
        final pasted = await showDialog<String>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Show me how you write'),
            content: TextField(controller: c, minLines: 5, maxLines: 10, decoration: const InputDecoration(hintText: 'Paste a few messages or emails you have sent (no private details needed).')),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')), FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('Learn'))],
          ),
        );
        if (pasted != null && pasted.trim().isNotEmpty && mounted) {
          setState(() => _learning = false);
          return _learn(pasted.trim());
        }
      } else {
        toast(context, errorText(e), error: true);
      }
    } finally {
      if (mounted) setState(() => _learning = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppState.of(context); // rebuild when the profile changes (e.g. after learning a voice)
    return SettingsPage(title: 'Profile & assistant', intro: 'How Carino addresses you and how it responds. Changes apply to new conversations.', children: [
      TextField(controller: _name, decoration: const InputDecoration(labelText: 'Your name'), onSubmitted: (v) => saveSettings(context, {'profile': {'displayName': v.trim()}})),
      const SizedBox(height: 12),
      TextField(controller: _assistant, maxLength: 40, decoration: const InputDecoration(labelText: 'Assistant’s name', helperText: 'Give your assistant any name you like.'), onSubmitted: (v) => v.trim().isEmpty ? null : saveSettings(context, {'profile': {'assistantName': v.trim()}})),
      const SizedBox(height: 4),
      Autocomplete<String>(
        initialValue: TextEditingValue(text: _lang.text),
        optionsBuilder: (v) => const ['English', 'Luganda', 'Swahili', 'Kinyarwanda', 'French', 'Spanish', 'Portuguese', 'German', 'Arabic', 'Hindi'].where((l) => l.toLowerCase().startsWith(v.text.toLowerCase())),
        onSelected: (v) => saveSettings(context, {'profile': {'replyLanguage': v}}),
        fieldViewBuilder: (context, c, f, onSubmit) => TextField(controller: c, focusNode: f, decoration: const InputDecoration(labelText: 'Reply language', helperText: 'Leave empty to reply in whatever language you write in.'), onSubmitted: (v) => saveSettings(context, {'profile': {'replyLanguage': v.trim()}})),
      ),
      const SizedBox(height: 14),
      const Text('Response style'),
      const SizedBox(height: 6),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final (v, label) in const [('balanced', 'Balanced'), ('concise', 'Short and direct'), ('detailed', 'Detailed'), ('warm', 'Warm'), ('upbeat', 'Upbeat'), ('playful', 'A little cheeky'), ('mine', 'Like me')])
          ChoiceChip(
            label: Text(label),
            selected: _style == v,
            onSelected: v == 'mine' && '${p['voiceProfile'] ?? ''}'.isEmpty
                ? (_) => _learn()
                : (_) {
                    setState(() => _style = v);
                    saveSettings(context, {'profile': {'assistantStyle': v}});
                  },
          ),
      ]),
      const SizedBox(height: 8),
      // "Like me": drafts Carino writes for you follow how you write.
      Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Sound like me', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(
              '${p['voiceProfile'] ?? ''}'.isEmpty
                  ? 'Carino can learn how you write from your own messages to it (never private chats), so the emails and messages it drafts for you sound like you. Only a short description is kept.'
                  : '${p['voiceProfile']}',
              style: const TextStyle(fontSize: 13),
            ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [
              FilledButton.tonal(onPressed: _learning ? null : _learn, child: Text(_learning ? 'Learning…' : '${p['voiceProfile'] ?? ''}'.isEmpty ? 'Learn how I write' : 'Learn again')),
              if ('${p['voiceProfile'] ?? ''}'.isNotEmpty)
                TextButton(
                  onPressed: () async {
                    final app = AppState.read(context);
                    await app.api.delete('/settings/voice');
                    await app.loadMe();
                    if (mounted) setState(() => _style = '${app.settings['profile']?['assistantStyle'] ?? 'balanced'}');
                  },
                  child: const Text('Forget it'),
                ),
            ]),
          ]),
        ),
      ),
      const SizedBox(height: 14),
      TextField(controller: _instr, maxLength: 2000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Instructions for Carino', hintText: 'e.g. I run a community pharmacy in Kampala. Use UGX for money.')),
      Align(alignment: Alignment.centerRight, child: FilledButton(onPressed: () => saveSettings(context, {'profile': {'customInstructions': _instr.text, 'displayName': _name.text.trim(), if (_assistant.text.trim().isNotEmpty) 'assistantName': _assistant.text.trim()}}), child: const Text('Save'))),
    ]);
  }
}

class MemorySettings extends StatelessWidget {
  const MemorySettings({super.key});

  @override
  Widget build(BuildContext context) {
    final m = (AppState.of(context).settings['memory'] as Map?) ?? const {};
    final disabled = ((m['disabledCategories'] as List?) ?? const []).cast<String>();
    return SettingsPage(title: 'Memory', intro: 'Long-term memory lets Carino remember what matters between conversations.', children: [
      SwitchListTile(contentPadding: EdgeInsets.zero, value: m['enabled'] != false, onChanged: (v) => saveSettings(context, {'memory': {'enabled': v}}), title: const Text('Use long-term memory'), subtitle: const Text('When off, Carino neither reads nor saves memories.')),
      DropdownButtonFormField<String>(
        initialValue: '${m['saveMode'] ?? 'ask_sensitive'}',
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'When Carino wants to remember something', helperText: 'Sensitive details and guesses always need your approval.', helperMaxLines: 2),
        items: const [
          DropdownMenuItem(value: 'ask_sensitive', child: Text('Save what I say; ask about sensitive or inferred')),
          DropdownMenuItem(value: 'ask', child: Text('Always ask me first')),
          DropdownMenuItem(value: 'explicit', child: Text('Only when I say “remember”')),
        ],
        onChanged: (v) => saveSettings(context, {'memory': {'saveMode': v}}),
      ),
      const SizedBox(height: 14),
      TextFormField(
        initialValue: '${m['retentionDays'] ?? 0}',
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Forget new memories after (days)', helperText: '0 keeps them until you delete them.'),
        onFieldSubmitted: (v) => saveSettings(context, {'memory': {'retentionDays': int.tryParse(v) ?? 0}}),
      ),
      const SizedBox(height: 14),
      const Text('Categories Carino may use'),
      Wrap(spacing: 6, children: [
        for (final c in const ['profile', 'preference', 'goal', 'routine', 'project', 'date', 'fact', 'summary'])
          FilterChip(label: Text(c), selected: !disabled.contains(c), onSelected: (on) => saveSettings(context, {'memory': {'disabledCategories': on ? disabled.where((x) => x != c).toList() : [...disabled, c]}})),
      ]),
      const SizedBox(height: 10),
      TextButton(onPressed: () => openPath(context, '/memory'), child: const Text('Manage your memories')),
    ]);
  }
}

class PermissionSettings extends StatefulWidget {
  const PermissionSettings({super.key});
  @override
  State<PermissionSettings> createState() => _PermissionSettingsState();
}

class _PermissionSettingsState extends State<PermissionSettings> {
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final p = (app.settings['permissions'] as Map?) ?? const {};
    return SettingsPage(title: 'Permissions', intro: 'Carino only acts through narrowly scoped tools — no general computer or shell access. Revoke any tool at any time.', children: [
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: p['autoReversible'] != false,
        title: const Text('Allow reversible changes without asking'),
        subtitle: const Text('E.g. adding to-dos and reminders when you ask. Turn off to approve each one.'),
        onChanged: (v) async {
          await saveSettings(context, {'permissions': {'autoReversible': v}});
          setState(() => _bump++);
        },
      ),
      Loader<List>(
        reloadKey: _bump,
        load: () async => ((await app.api.get('/tools')) as Map)['tools'] as List,
        builder: (context, tools, _) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final (risk, label) in const [('read', 'Read-only — looks things up, changes nothing'), ('reversible', 'Reversible changes — creates or edits your data'), ('consequential', 'Consequential — deletions; always need approval')]) ...[
            Padding(padding: const EdgeInsets.fromLTRB(0, 18, 0, 4), child: Text(label, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary))),
            for (final t in tools.cast<Map>().where((t) => t['risk'] == risk))
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${t['name']}'.replaceAll('_', ' ')),
                subtitle: Text('${t['description']}', maxLines: 2, overflow: TextOverflow.ellipsis),
                trailing: DropdownButton<String>(
                  value: '${t['mode']}',
                  underline: const SizedBox(),
                  items: [if (risk != 'consequential') const DropdownMenuItem(value: 'auto', child: Text('Allowed')), const DropdownMenuItem(value: 'ask', child: Text('Ask first')), const DropdownMenuItem(value: 'off', child: Text('Off'))],
                  onChanged: (v) async {
                    final cur = Map<String, dynamic>.from((p['tools'] as Map?) ?? const {});
                    await saveSettings(context, {'permissions': {'tools': {...cur, '${t['name']}': v}}}, 'Permission updated');
                    setState(() => _bump++);
                  },
                ),
              ),
          ],
        ]),
      ),
    ]);
  }
}

class NotificationSettings extends StatefulWidget {
  const NotificationSettings({super.key});
  @override
  State<NotificationSettings> createState() => _NotificationSettingsState();
}

class _NotificationSettingsState extends State<NotificationSettings> {
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final n = (app.settings['notifications'] as Map?) ?? const {};
    Future<void> pickTime(String key) async {
      final cur = '${n[key] ?? ''}';
      final t = await showTimePicker(context: context, initialTime: cur.contains(':') ? TimeOfDay(hour: int.parse(cur.split(':')[0]), minute: int.parse(cur.split(':')[1])) : const TimeOfDay(hour: 22, minute: 0));
      if (t != null && context.mounted) await saveSettings(context, {'notifications': {key: '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'}});
    }

    return SettingsPage(title: 'Notifications & routines', intro: 'Reminders ring on this phone, even when Carino is closed.', children: [
      SwitchListTile(contentPadding: EdgeInsets.zero, value: n['push'] != false, onChanged: (v) => saveSettings(context, {'notifications': {'push': v}}), title: const Text('Notifications'), subtitle: const Text('Turn off to keep reminders in the app only.')),
      ListTile(contentPadding: EdgeInsets.zero, title: const Text('Send a test'), subtitle: const Text('Check notifications are allowed for Carino in your phone’s settings.'), trailing: OutlinedButton(onPressed: () async {
        try {
          await app.api.post('/push/test');
          if (context.mounted) toast(context, 'Test notification sent');
        } catch (e) {
          if (context.mounted) toast(context, errorText(e), error: true);
        }
      }, child: const Text('Send test'))),
      ListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Quiet hours'),
        subtitle: Text(n['quietHoursStart'] == null ? 'Off — reminders ring any time' : '${n['quietHoursStart']} to ${n['quietHoursEnd'] ?? '…'} · reminders wait until they end'),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          TextButton(onPressed: () => pickTime('quietHoursStart'), child: const Text('From')),
          TextButton(onPressed: () => pickTime('quietHoursEnd'), child: const Text('To')),
          if (n['quietHoursStart'] != null) IconButton(tooltip: 'Turn off quiet hours', icon: const Icon(Icons.close), onPressed: () => saveSettings(context, {'notifications': {'quietHoursStart': null, 'quietHoursEnd': null}})),
        ]),
      ),
      const SizedBox(height: 14),
      Text('Briefings', style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary)),
      Loader<List>(
        reloadKey: _bump,
        load: () async => ((await app.api.get('/routines')) as Map)['routines'] as List,
        builder: (context, list, _) => Column(children: [
          for (final r in list.cast<Map>().where((r) => r['custom'] != true))
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${r['title']}'),
              subtitle: Text('At ${r['time_local']}'),
              onTap: () async {
                final p = '${r['time_local']}'.split(':');
                final t = await showTimePicker(context: context, initialTime: TimeOfDay(hour: int.parse(p[0]), minute: int.parse(p[1])));
                if (t == null) return;
                await app.api.patch('/routines/${r['id']}', {'time_local': '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}'});
                setState(() => _bump++);
              },
              trailing: Switch(value: r['enabled'] == true, onChanged: (v) async {
                await app.api.patch('/routines/${r['id']}', {'enabled': v});
                setState(() => _bump++);
              }),
            ),
          TextButton(onPressed: () => openPath(context, '/routines'), child: const Text('All routines')),
        ]),
      ),
    ]);
  }
}

class AppearanceSettings extends StatelessWidget {
  const AppearanceSettings({super.key});

  @override
  Widget build(BuildContext context) {
    final a = (AppState.of(context).settings['appearance'] as Map?) ?? const {};
    return SettingsPage(title: 'Appearance & accessibility', children: [
      const Text('Theme'),
      const SizedBox(height: 6),
      SegmentedButton<String>(segments: const [ButtonSegment(value: 'system', label: Text('System')), ButtonSegment(value: 'light', label: Text('Light')), ButtonSegment(value: 'dark', label: Text('Dark'))], selected: {'${a['theme'] ?? 'system'}'}, onSelectionChanged: (s) => saveSettings(context, {'appearance': {'theme': s.first}})),
      const SizedBox(height: 16),
      const Text('Colour palette'),
      const SizedBox(height: 6),
      SegmentedButton<String>(segments: const [ButtonSegment(value: 'classic', label: Text('Classic')), ButtonSegment(value: 'midnight', label: Text('Midnight'))], selected: {'${a['palette'] ?? 'classic'}'}, onSelectionChanged: (s) => saveSettings(context, {'appearance': {'palette': s.first}})),
      const SizedBox(height: 16),
      const Text('Text size'),
      const SizedBox(height: 6),
      SegmentedButton<String>(segments: const [ButtonSegment(value: 'normal', label: Text('Normal')), ButtonSegment(value: 'large', label: Text('Large'))], selected: {'${a['textSize'] ?? 'normal'}'}, onSelectionChanged: (s) => saveSettings(context, {'appearance': {'textSize': s.first}})),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: a['reduceMotion'] == true, onChanged: (v) => saveSettings(context, {'appearance': {'reduceMotion': v}}), title: const Text('Reduce motion'), subtitle: const Text('Turns off animations.')),
    ]);
  }
}

class RegionalSettings extends StatelessWidget {
  const RegionalSettings({super.key});

  @override
  Widget build(BuildContext context) {
    final r = (AppState.of(context).settings['regional'] as Map?) ?? const {};
    final tz = '${r['timeZone'] ?? ''}';
    return SettingsPage(title: 'Language & region', intro: 'Used for dates, reminders, briefings and natural-language scheduling.', children: [
      TextFormField(
        initialValue: tz,
        decoration: const InputDecoration(labelText: 'Time zone', helperText: 'e.g. Africa/Kampala, Europe/London'),
        onFieldSubmitted: (v) => saveSettings(context, {'regional': {'timeZone': v.trim()}}),
      ),
      const SizedBox(height: 14),
      DropdownButtonFormField<String>(
        initialValue: '${r['locale'] ?? 'en-GB'}',
        decoration: const InputDecoration(labelText: 'Date format'),
        items: const [
          DropdownMenuItem(value: 'en-GB', child: Text('16 Oct 2026 (UK)')), DropdownMenuItem(value: 'en-US', child: Text('Oct 16, 2026 (US)')),
          DropdownMenuItem(value: 'en-UG', child: Text('Uganda (en-UG)')), DropdownMenuItem(value: 'en-KE', child: Text('Kenya (en-KE)')),
          DropdownMenuItem(value: 'fr-FR', child: Text('Français')), DropdownMenuItem(value: 'sw-KE', child: Text('Kiswahili')),
        ],
        onChanged: (v) => saveSettings(context, {'regional': {'locale': v}}),
      ),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: r['hour12'] == true, onChanged: (v) => saveSettings(context, {'regional': {'hour12': v}}), title: const Text('12-hour clock')),
    ]);
  }
}

class VoiceSettings extends StatelessWidget {
  const VoiceSettings({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    final v = (app.settings['voice'] as Map?) ?? const {};
    return SettingsPage(title: 'Voice', intro: 'Optional. Carino only listens while the microphone is on, and never records in the background. Speech uses your phone’s own speech service and voices.', children: [
      SwitchListTile(contentPadding: EdgeInsets.zero, value: v['enabled'] != false, onChanged: (x) => saveSettings(context, {'voice': {'enabled': x}}), title: const Text('Enable voice features')),
      DropdownButtonFormField<String>(
        initialValue: '${v['language'] ?? 'en-US'}',
        decoration: const InputDecoration(labelText: 'Speech language'),
        items: [for (final l in const ['en-US', 'en-GB', 'en-UG', 'en-KE', 'sw-KE', 'fr-FR', 'lg-UG']) DropdownMenuItem(value: l, child: Text(l))],
        onChanged: (x) => saveSettings(context, {'voice': {'language': x}}),
      ),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: v['speakReplies'] == true, onChanged: (x) => saveSettings(context, {'voice': {'speakReplies': x}}), title: const Text('Read replies aloud automatically')),
      SwitchListTile(contentPadding: EdgeInsets.zero, value: v['speakBrief'] == true, onChanged: (x) => saveSettings(context, {'voice': {'speakBrief': x}}), title: const Text('Read my brief aloud when I first open Carino each day')),
      const SizedBox(height: 8),
      const Text('In voice mode you can say “pause”, “repeat that”, “skip”, “read my brief” or “stop”. These are handled on your phone, not sent to the AI.'),
      const SizedBox(height: 12),
      OutlinedButton.icon(onPressed: () => Device(app.api).speak('Hello, I’m ${app.assistantName}. This is how I sound.', '${v['language'] ?? 'en-US'}'), icon: const Icon(Icons.volume_up_outlined), label: const Text('Test the voice')),
    ]);
  }
}

class PrivacySettings extends StatelessWidget {
  const PrivacySettings({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return SettingsPage(title: 'Privacy, data & backup', children: [
      const Text('Everything — to-dos, reminders, memories, files and chats — is stored on this phone only. Nothing is sold or shared. When you chat, the conversation, relevant memories and attached text go to the AI service you chose so it can reply.'),
      const SizedBox(height: 12),
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: const Icon(Icons.download_outlined),
        title: const Text('Export all data'),
        subtitle: const Text('A JSON file with your to-dos, reminders, memories, chats and settings, saved to Downloads.'),
        onTap: () async {
          try {
            final m = await saveApiFile(app.engine, '/export', fallbackName: 'carino-export.json');
            if (context.mounted) toast(context, m);
          } catch (e) {
            if (context.mounted) toast(context, errorText(e), error: true);
          }
        },
      ),
      const SizedBox(height: 8),
      const Section(title: 'Backup & restore', subtitle: 'Your data isn’t in Android’s own phone backup (it would include the key to your sign-ins). Make your own encrypted backups here.', child: BackupPanel()),
      const SizedBox(height: 12),
      Section(
        title: 'Erase everything',
        subtitle: 'Deletes every to-do, reminder, memory, file, chat, setting and your AI key from this phone. This cannot be undone.',
        child: Align(
          alignment: Alignment.centerLeft,
          child: FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () async {
              if (!await confirmDialog(context, title: 'Erase everything on this phone?', body: 'Carino starts again from the beginning.', confirm: 'Erase everything', danger: true)) return;
              await app.api.post('/device/reset');
              await app.engine.restart();
              await app.loadMe();
              if (context.mounted) {
                Navigator.of(context).popUntil((r) => r.isFirst);
                app.changed();
                openPath(context, '/');
              }
            },
            child: const Text('Erase everything…'),
          ),
        ),
      ),
    ]);
  }
}

String _when(String name) {
  final m = RegExp(r'(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})').firstMatch(name);
  return m == null ? name : fmtDateTime('${m.group(1)}T${m.group(2)}:${m.group(3)}:00Z');
}

/// Encrypted backups: make one (tested before it's kept), save or copy it, restore with a preview.
class BackupPanel extends StatefulWidget {
  const BackupPanel({super.key});
  @override
  State<BackupPanel> createState() => _BackupPanelState();
}

class _BackupPanelState extends State<BackupPanel> {
  final _pass = TextEditingController();
  String _busy = '';
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final app = AppState.of(context);
    return Loader<Map>(
      reloadKey: _bump,
      load: () async => await app.api.get('/backup') as Map,
      builder: (context, data, _) {
        final backups = (data['backups'] as List? ?? const []).cast<Map>();
        final cloud = (data['cloud'] as List? ?? const []).cast<Map>();
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('A backup is locked with a passphrase you choose; without it nobody can open it. Each backup is checked by restoring it in a test before it’s kept. Sign-ins aren’t included.', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 10),
          TextField(controller: _pass, obscureText: true, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Passphrase (10+ characters)')),
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: _busy.isNotEmpty || _pass.text.length < 10
                ? null
                : () async {
                    setState(() => _busy = 'make');
                    try {
                      final r = await app.api.post('/backup', {'passphrase': _pass.text}) as Map;
                      if (context.mounted) toast(context, 'Backup made and checked: ${r['records']} records, ${r['files']} files. Keep your passphrase safe.');
                      _pass.clear();
                    } catch (e) {
                      if (context.mounted) toast(context, errorText(e), error: true);
                    } finally {
                      if (mounted) setState(() { _busy = ''; _bump++; });
                    }
                  },
            icon: const Icon(Icons.lock_outline),
            label: Text(_busy == 'make' ? 'Making and checking…' : 'Make a backup'),
          ),
          for (final b in backups)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${b['kind'] == 'safety' ? 'Before restore · ' : ''}${_when('${b['name']}')}'),
              subtitle: Text('${((b['size'] as num? ?? 0) / 1024).round()} KB · encrypted'),
              trailing: PopupMenuButton<String>(
                onSelected: (v) async {
                  if (v == 'save') {
                    final m = await saveApiFile(app.engine, '/backup/files/${b['name']}', fallbackName: '${b['name']}').catchError((e) => errorText(e));
                    if (context.mounted) toast(context, m);
                  } else if (v == 'restore') {
                    await _restore(context, name: '${b['name']}');
                  } else if (v == 'delete') {
                    if (!await confirmDialog(context, title: 'Delete this backup?', confirm: 'Delete', danger: true)) return;
                    await app.api.delete('/backup/files/${b['name']}');
                    setState(() => _bump++);
                  } else if (v.startsWith('cloud:')) {
                    try {
                      final r = await app.api.post('/backup/cloud', {'name': b['name'], 'account_id': v.substring(6)}) as Map;
                      if (context.mounted) toast(context, 'Saved to ${r['where']}');
                    } catch (e) {
                      if (context.mounted) toast(context, errorText(e), error: true);
                    }
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'save', child: Text('Save to Downloads')),
                  for (final a in cloud) PopupMenuItem(value: 'cloud:${a['id']}', child: Text('Copy to ${a['provider'] == 'google' ? 'Google Drive' : 'OneDrive'} · ${a['label']}')),
                  const PopupMenuItem(value: 'restore', child: Text('Restore')),
                  const PopupMenuItem(value: 'delete', child: Text('Delete')),
                ],
              ),
            ),
          const SizedBox(height: 6),
          OutlinedButton.icon(
            onPressed: () async {
              final files = await pickUploads();
              if (files.isNotEmpty && context.mounted) await _restore(context, file: files.first);
            },
            icon: const Icon(Icons.upload_file),
            label: const Text('Restore from a file…'),
          ),
          if (cloud.isEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('To keep a copy in Google Drive or OneDrive, connect it in My apps (optional). The copy stays encrypted.', style: Theme.of(context).textTheme.bodySmall)),
        ]);
      },
    );
  }

  Future<void> _restore(BuildContext context, {String? name, Upload? file}) async {
    final app = AppState.read(context);
    final done = await showModalBottomSheet<bool>(context: context, isScrollControlled: true, useSafeArea: true, builder: (_) => _RestoreSheet(name: name, file: file));
    if (done == true && context.mounted) {
      await app.engine.restart();
      await app.loadMe();
      if (context.mounted) {
        app.changed();
        setState(() => _bump++);
      }
    }
  }
}

class _RestoreSheet extends StatefulWidget {
  final String? name;
  final Upload? file;
  const _RestoreSheet({this.name, this.file});
  @override
  State<_RestoreSheet> createState() => _RestoreSheetState();
}

class _RestoreSheetState extends State<_RestoreSheet> {
  final _pass = TextEditingController();
  Map? _preview;
  String _mode = 'merge';
  bool _busy = false;

  Future<Map> _send(String path, [Map<String, String> extra = const {}]) async {
    final app = AppState.read(context);
    if (widget.name != null) return await app.api.post(path, {'name': widget.name, 'passphrase': _pass.text, ...extra.map((k, v) => MapEntry(k, v == 'true' ? true : v))}) as Map;
    final f = widget.file!;
    final r = await app.engine.send('POST', path, upload: Upload(name: f.name, mime: f.mime, bytes: f.bytes, fields: {'passphrase': _pass.text, ...extra}));
    final d = r.json;
    if (!r.ok) throw ApiError(r.status, (d is Map ? d['error'] as String? : null) ?? 'That didn’t work.');
    return d as Map;
  }

  @override
  Widget build(BuildContext context) {
    final p = _preview;
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Restore a backup', style: t.titleLarge),
        const SizedBox(height: 10),
        if (p == null) ...[
          TextField(controller: _pass, obscureText: true, autofocus: true, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: 'Passphrase for ${widget.name ?? widget.file?.name}', helperText: 'Opening it only checks and previews: nothing changes yet.')),
          const SizedBox(height: 10),
          FilledButton(
            onPressed: _busy || _pass.text.isEmpty
                ? null
                : () async {
                    setState(() => _busy = true);
                    try {
                      final r = await _send('/backup/inspect');
                      setState(() => _preview = r);
                    } catch (e) {
                      if (context.mounted) toast(context, errorText(e), error: true);
                    } finally {
                      if (mounted) setState(() => _busy = false);
                    }
                  },
            child: Text(_busy ? 'Opening…' : 'Open and preview'),
          ),
        ] else ...[
          Text('Backup from ${fmtDateTime(p['created_at'] as String?)} — opened and checked.'),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(columnSpacing: 14, columns: const [DataColumn(label: Text('What')), DataColumn(label: Text('In backup')), DataColumn(label: Text('Here now')), DataColumn(label: Text('New')), DataColumn(label: Text('Different'))], rows: [
              for (final r in (p['tables'] as List).cast<Map>().where((r) => (r['in_backup'] as num) > 0 || (r['on_device'] as num) > 0))
                DataRow(cells: [DataCell(Text('${r['table']}'.replaceAll('_', ' '))), DataCell(Text('${r['in_backup']}')), DataCell(Text('${r['on_device']}')), DataCell(Text('${r['new']}')), DataCell(Text('${r['different']}'))]),
            ]),
          ),
          RadioGroup<String>(
            groupValue: _mode,
            onChanged: (v) => setState(() => _mode = v ?? 'merge'),
            child: const Column(children: [
              RadioListTile<String>(contentPadding: EdgeInsets.zero, value: 'merge', title: Text('Add what’s missing'), subtitle: Text('Keeps everything here; where a record differs, the one here is kept.')),
              RadioListTile<String>(contentPadding: EdgeInsets.zero, value: 'replace', title: Text('Replace everything'), subtitle: Text('This account becomes exactly the backup. Anything added since is removed.')),
            ]),
          ),
          Text('Before restoring, what’s here now is saved as an encrypted “Before restore” backup with the same passphrase, so you can undo it.', style: t.bodySmall),
          const SizedBox(height: 10),
          FilledButton(
            style: _mode == 'replace' ? FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error) : null,
            onPressed: _busy
                ? null
                : () async {
                    setState(() => _busy = true);
                    try {
                      final r = await _send('/backup/restore', {'mode': _mode, 'confirm': 'true'});
                      if (context.mounted) {
                        toast(context, 'Restored. ${r['note'] ?? ''}');
                        Navigator.pop(context, true);
                      }
                    } catch (e) {
                      if (context.mounted) toast(context, errorText(e), error: true);
                      if (mounted) setState(() => _busy = false);
                    }
                  },
            child: Text(_busy ? 'Restoring…' : _mode == 'replace' ? 'Replace everything' : 'Add what’s missing'),
          ),
        ],
      ]),
    );
  }
}
