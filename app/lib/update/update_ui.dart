import 'dart:io';
import '../l10n.dart';

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../screens/settings.dart';
import '../widgets/common.dart';
import 'updater.dart';

DateTime? _lastCheck;

/// When Carino opens (at most once a day): if automatic updates are on and a newer version is
/// out, download and check it, then install it (Windows) or offer it (Android).
Future<void> autoUpdate(BuildContext context) async {
  final app = AppState.read(context);
  final auto = (app.settings['updates'] as Map?)?['auto'] != false;
  if (!auto || (!Platform.isAndroid && !Platform.isWindows)) return;
  if (_lastCheck != null && DateTime.now().difference(_lastCheck!) < const Duration(hours: 20)) return;
  _lastCheck = DateTime.now();
  try {
    final u = await checkForUpdate();
    if (u == null) return;
    final f = await download(u);
    if (!context.mounted) return;
    if (Platform.isWindows) {
      final messenger = ScaffoldMessenger.of(context);
      messenger.showSnackBar(SnackBar(content: Tx('Updating Carino to {0}… it reopens in a moment.', args: [u.version])));
      await Future<void>.delayed(const Duration(seconds: 3));
      await install(f);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      duration: const Duration(seconds: 20),
      content: Tx('Carino {0} is ready to install.', args: [u.version]),
      action: SnackBarAction(label: tr('Install'), onPressed: () => install(f)),
    ));
  } catch (_) {
    // Updates are a convenience: try again next time.
  }
}

/// Settings → Updates.
class UpdateSettings extends StatefulWidget {
  const UpdateSettings({super.key});
  @override
  State<UpdateSettings> createState() => _UpdateSettingsState();
}

class _UpdateSettingsState extends State<UpdateSettings> {
  String? _current;
  String? _status;
  double? _progress;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    currentVersion().then((v) { if (mounted) setState(() => _current = v); }).catchError((_) {});
  }

  Future<void> _check() async {
    setState(() { _busy = true; _status = 'Checking…'; _progress = null; });
    try {
      final u = await checkForUpdate();
      if (u == null) {
        setState(() => _status = 'Carino is up to date.');
        return;
      }
      setState(() => _status = 'Downloading ${u.version}…');
      final f = await download(u, progress: (p) { if (mounted) setState(() => _progress = p); });
      setState(() { _status = 'Carino ${u.version} is downloaded and checked.'; _progress = null; });
      final ok = await install(f);
      if (!ok && mounted) setState(() => _status = 'Allow Carino to install updates on the page that opened, then tap Check again.');
    } catch (e) {
      if (mounted) setState(() => _status = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final u = (AppState.of(context).settings['updates'] as Map?) ?? const {};
    return SettingsPage(title: tr('Updates'), intro: tr('Carino updates itself from its official releases. Each download is checked before it is installed, and your data is kept.'), children: [
      ListTile(contentPadding: EdgeInsets.zero, title: const Tx('This version'), trailing: Text(_current ?? '…')),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: u['auto'] != false,
        onChanged: (v) => saveSettings(context, {'updates': {'auto': v}}),
        title: const Tx('Update automatically'),
        subtitle: Text(Platform.isAndroid ? 'Downloads new versions; Android asks you to confirm the install.' : 'Installs new versions quietly when Carino opens.'),
      ),
      const SizedBox(height: 8),
      FilledButton.tonal(onPressed: _busy ? null : _check, child: const Tx('Check now')),
      if (_progress != null) Padding(padding: const EdgeInsets.only(top: 10), child: LinearProgressIndicator(value: _progress)),
      if (_status != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(_status!)),
    ]);
  }
}
