import 'dart:convert';
import 'dart:io' show Platform;
import '../l10n.dart';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_windows/webview_windows.dart' as win;

import '../app_state.dart';
import '../engine/device.dart';
import '../widgets/common.dart';
import '../widgets/ui.dart';

/// Pages and small apps Carino built in chat.
class PagesScreen extends StatefulWidget {
  const PagesScreen({super.key});
  @override
  State<PagesScreen> createState() => _PagesScreenState();
}

class _PagesScreenState extends State<PagesScreen> {
  int _bump = 0;

  @override
  Widget build(BuildContext context) {
    final api = AppState.of(context).api;
    return Scaffold(
      appBar: AppBar(title: const Tx('Pages & apps')),
      body: Loader<List>(
        reloadKey: _bump,
        load: () async => ((await api.get('/pages')) as Map)['pages'] as List,
        builder: (context, list, _) => list.isEmpty
            ? EmptyView(icon: Icons.web_outlined, title: tr('Nothing built yet'), body: tr('Ask Carino to make a page or a small app — an invite, a menu, a checklist, a quiz — and it appears here.'))
            : ListView(padding: const EdgeInsets.all(16), children: [
                for (final p in list.cast<Map>())
                  Card(
                    margin: const EdgeInsets.only(bottom: 8),
                    child: ListTile(
                      leading: Icon(p['kind'] == 'app' ? Icons.widgets_outlined : Icons.web_outlined),
                      title: Text('${p['title']}'),
                      subtitle: Tx('Version {0} · {1}', args: [p['version'], fmtDateTime('${p['updated_at']}')]),
                      onTap: () async {
                        await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => BuiltPageView('${p['id']}')));
                        setState(() => _bump++);
                      },
                    ),
                  ),
              ]),
      ),
    );
  }
}

/// One page, shown in its own sandboxed view (no access to Carino), with versions and sharing.
class BuiltPageView extends StatefulWidget {
  final String id;
  const BuiltPageView(this.id, {super.key});
  @override
  State<BuiltPageView> createState() => _BuiltPageViewState();
}

class _BuiltPageViewState extends State<BuiltPageView> {
  Map? _page;
  String? _html;
  int? _version;
  WebViewController? _android;
  win.WebviewController? _windows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _windows?.dispose();
    super.dispose();
  }

  Future<void> _load([int? version]) async {
    final app = AppState.read(context);
    final page = await app.api.get('/pages/${widget.id}') as Map;
    final r = await app.engine.send('GET', '/pages/${widget.id}/html${version != null ? '?version=$version' : ''}');
    final html = r.bytes != null ? utf8.decode(r.bytes!) : r.body;
    if (!mounted) return;
    if (Platform.isWindows) {
      final c = _windows ?? (win.WebviewController());
      if (_windows == null) {
        await c.initialize();
        await c.setPopupWindowPolicy(win.WebviewPopupWindowPolicy.deny);
        _windows = c;
      }
      await c.loadStringContent(html);
    } else {
      final c = _android ?? WebViewController();
      if (_android == null) {
        // JavaScript for the page's own interactivity only; no bridge into Carino, no navigation away.
        await c.setJavaScriptMode(JavaScriptMode.unrestricted);
        await c.setNavigationDelegate(NavigationDelegate(onNavigationRequest: (req) => req.url.startsWith('about:') || req.url.startsWith('data:') ? NavigationDecision.navigate : NavigationDecision.prevent));
        _android = c;
      }
      await c.loadHtmlString(html);
    }
    setState(() {
      _page = page;
      _html = html;
      _version = version ?? (page['version'] as num?)?.toInt();
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = _page;
    final api = AppState.read(context).api;
    final history = ((p?['history'] as List?) ?? const []).cast<Map>();
    return Scaffold(
      appBar: AppBar(
        title: Text('${p?['title'] ?? 'Page'}'),
        actions: [
          if (history.isNotEmpty)
            PopupMenuButton<int>(
              tooltip: tr('Versions'),
              icon: const Icon(Icons.history),
              onSelected: (v) => _load(v == p?['version'] ? null : v),
              itemBuilder: (_) => [
                PopupMenuItem(value: (p?['version'] as num?)?.toInt() ?? 0, child: Tx('Version {0} (latest)', args: [p?['version']])),
                for (final h in history.reversed) PopupMenuItem(value: (h['version'] as num).toInt(), child: Tx('Version {0} · {1}', args: [h['version'], fmtDateTime('${h['at']}')])),
              ],
            ),
          if (_version != null && p != null && _version != p['version'])
            TextButton(
              onPressed: () async {
                await api.post('/pages/${widget.id}/restore', {'version': _version});
                await _load();
                if (context.mounted) toast(context, tr('Restored as the latest version'));
              },
              child: const Tx('Restore this'),
            ),
          IconButton(
            tooltip: tr('Share'),
            icon: const Icon(Icons.share_outlined),
            onPressed: _html == null ? null : () => Device(api).shareFile('${p?['title'] ?? 'page'}.html', 'text/html', utf8.encode(_html!)),
          ),
          IconButton(
            tooltip: tr('Delete'),
            icon: const Icon(Icons.delete_outline),
            onPressed: () async {
              if (!await confirmDialog(context, title: tr('Delete this page?'), body: tr('Its earlier versions go too.'), confirm: tr('Delete'), danger: true)) return;
              await api.delete('/pages/${widget.id}');
              if (context.mounted) Navigator.pop(context);
            },
          ),
        ],
      ),
      body: _html == null
          ? const Center(child: CircularProgressIndicator())
          : Platform.isWindows
              ? win.Webview(_windows!)
              : WebViewWidget(controller: _android!),
    );
  }
}
