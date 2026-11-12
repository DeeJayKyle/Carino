import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../nav.dart';
import '../engine/device.dart';
import '../engine/engine.dart';
import '../widgets/api_image.dart';
import '../widgets/common.dart';
import '../widgets/dictation.dart';
import '../widgets/files.dart';

/// One conversation: messages, a streamed reply, what tools did, and which model answered.
class ChatScreen extends StatefulWidget {
  final String conversationId;
  final String? firstMessage;
  final String? draft;
  /// Hands-free: listen, answer out loud, listen again.
  final bool voice;
  const ChatScreen({super.key, required this.conversationId, this.firstMessage, this.draft, this.voice = false});

  /// Creates a chat and opens it, optionally sending a first message.
  static Future<void> startNew(BuildContext context, {String? firstMessage, String? draft, bool voice = false}) async {
    final app = AppState.read(context);
    try {
      final c = await app.api.post('/conversations', {}) as Map;
      if (!context.mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChatScreen(conversationId: c['id'] as String, firstMessage: firstMessage, draft: draft, voice: voice)));
      app.changed();
    } catch (e) {
      if (context.mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class Msg {
  final String id;
  final String role;
  String content;
  List<Map<String, dynamic>> tools;
  String? model;
  List<Map> attachments;
  Msg({required this.id, required this.role, required this.content, this.tools = const [], this.model, this.attachments = const []});

  factory Msg.fromJson(Map m) {
    final meta = (m['meta'] as Map?) ?? const {};
    return Msg(
      id: '${m['id']}', role: '${m['role']}', content: '${m['content'] ?? ''}',
      tools: ((meta['tools'] as List?) ?? const []).cast<Map>().map((t) => Map<String, dynamic>.from(t)).toList(),
      model: meta['model'] as String?,
      attachments: ((meta['attachments'] as List?) ?? const []).cast<Map>(),
    );
  }
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _messages = <Msg>[];
  Map<String, dynamic>? _conv;
  bool _loading = true;
  Object? _error;
  StreamSubscription<SseEvent>? _sub;
  Msg? _streaming;
  String? _modelLabel;
  String? _modelReason;
  final _files = <Map>[];
  bool _uploading = false;
  Dictation? _dict;
  bool _voiceMode = false;
  bool _speaking = false;
  StreamSubscription<EngineEvent>? _spoken;

  @override
  void initState() {
    super.initState();
    if (widget.draft != null) _input.text = widget.draft!;
    _load().then((_) {
      if (widget.firstMessage != null) _send(widget.firstMessage!);
      if (widget.voice && mounted) _toggleVoiceMode();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_dict != null) return;
    final app = AppState.read(context);
    _dict = Dictation(
      engine: app.engine,
      device: Device(app.api),
      lang: '${(app.settings['voice'] as Map?)?['language'] ?? 'en-US'}',
      onFinal: (t) {
        if (_voiceMode) {
          _send(t);
        } else {
          _input.text = _input.text.isEmpty ? t : '${_input.text} $t';
        }
      },
    )..addListener(() { if (mounted) setState(() {}); });
    // The phone finished reading a reply out loud: listen for the next thing to say.
    _spoken = app.engine.events.where((e) => e.name == 'spoken').listen((_) {
      if (!mounted) return;
      setState(() => _speaking = false);
      if (_voiceMode && _streaming == null) _dict!.start();
    });
  }

  bool get _voiceOn => (AppState.read(context).settings['voice'] as Map?)?['enabled'] != false;

  Future<void> _toggleVoiceMode() async {
    final device = Device(AppState.read(context).api);
    if (_voiceMode) {
      setState(() { _voiceMode = false; _speaking = false; });
      await _dict!.stop();
      await device.stopSpeaking().catchError((_) {});
      return;
    }
    setState(() => _voiceMode = true);
    await _dict!.start();
  }

  /// Reads a reply out loud (without the markdown marks).
  void _speak(String text) {
    final app = AppState.read(context);
    final plain = text
        .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m.group(1)!)
        .replaceAll(RegExp(r'[*_`#>|]'), '')
        .replaceAll(RegExp(r'\n{2,}'), '. ')
        .trim();
    if (plain.isEmpty) return;
    setState(() => _speaking = true);
    Device(app.api).speak(plain, '${(app.settings['voice'] as Map?)?['language'] ?? 'en-US'}').catchError((_) {
      if (mounted) setState(() => _speaking = false);
    });
  }

  Future<void> _attach() async {
    final api = AppState.read(context).api;
    try {
      final picked = await pickUploads(multiple: true);
      if (picked.isEmpty) return;
      setState(() => _uploading = true);
      for (final f in picked.take(5 - _files.length)) {
        final r = await api.upload(f);
        final d = (r['document'] as Map?) ?? const {};
        if (mounted) setState(() => _files.add({'id': d['id'], 'filename': d['filename'] ?? f.name, 'kind': d['kind']}));
      }
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  void dispose() {
    _spoken?.cancel();
    _dict?.dispose();
    if (_speaking) Device(AppState.read(context).api).stopSpeaking().catchError((_) {});
    _sub?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await AppState.read(context).api.get('/conversations/${widget.conversationId}') as Map;
      final msgs = ((d['messages'] as List?) ?? const [])
          .cast<Map>()
          .where((m) => (m['role'] == 'user' || m['role'] == 'assistant') && ((m['meta'] as Map?)?['hidden'] != 1))
          .map(Msg.fromJson);
      if (!mounted) return;
      setState(() {
        _conv = Map<String, dynamic>.from(d['conversation'] as Map);
        _messages
          ..clear()
          ..addAll(msgs);
        _loading = false;
      });
      _toEnd();
    } catch (e) {
      if (mounted) setState(() { _error = e; _loading = false; });
    }
  }

  void _toEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  void _send([String? text]) {
    final t = (text ?? _input.text).trim();
    if (t.isEmpty || _streaming != null) return;
    _input.clear();
    final app = AppState.read(context);
    final reply = Msg(id: 'streaming', role: 'assistant', content: '', tools: []);
    final files = List<Map>.of(_files);
    setState(() {
      _messages.add(Msg(id: 'pending-${DateTime.now().microsecondsSinceEpoch}', role: 'user', content: t, attachments: files));
      _streaming = reply;
      _files.clear();
    });
    _toEnd();
    _sub = app.engine.stream('POST', '/conversations/${widget.conversationId}/messages', body: {'text': t, if (files.isNotEmpty) 'attachments': [for (final f in files) f['id']]}).listen((e) {
      if (!mounted) return;
      setState(() {
        switch (e.event) {
          case 'start':
            final p = (e.data['provider'] as Map?) ?? const {};
            _modelLabel = '${p['label'] ?? ''}${p['model'] != null ? ' · ${p['model']}' : ''}';
            _modelReason = p['reason'] as String?;
          case 'switch':
            final p = (e.data['provider'] as Map?) ?? const {};
            _modelLabel = '${p['label'] ?? ''} · ${p['model'] ?? ''}';
            toast(context, '${p['reason'] ?? 'Switched to another model'}');
          case 'text':
            reply.content += '${e.data['delta'] ?? ''}';
          case 'tool':
            final i = reply.tools.indexWhere((x) => x['id'] == e.data['id']);
            if (i >= 0) {
              reply.tools[i] = e.data;
            } else {
              reply.tools.add(e.data);
            }
            if (e.data['status'] == 'pending_approval') app.changed();
          case 'message':
            final m = e.data['message'];
            if (m is Map) _messages.add(Msg.fromJson(m));
            _streaming = null;
            if (_voiceMode && m is Map) _speak('${m['content'] ?? ''}');
          case 'error':
            _streaming = null;
            toast(context, '${e.data['message'] ?? 'The reply failed.'}', error: true);
        }
      });
      _toEnd();
    }, onError: (Object err) {
      if (mounted) setState(() => _streaming = null);
      if (mounted) toast(context, errorText(err), error: true);
    }, onDone: () {
      if (mounted && _streaming != null) setState(() => _streaming = null);
    });
  }

  Future<void> _stop() async {
    await _sub?.cancel();
    _sub = null;
    if (!mounted) return;
    await AppState.read(context).api.post('/conversations/${widget.conversationId}/cancel').catchError((_) => null);
    await _load();
    if (mounted) setState(() => _streaming = null);
  }

  Future<void> _togglePrivate() async {
    final lo = (_conv?['local_only'] as num?)?.toInt() ?? 0;
    try {
      final r = await AppState.read(context).api.patch('/conversations/${widget.conversationId}/local-only', {'local_only': lo == 0}) as Map;
      if (!mounted) return;
      setState(() => _conv?['local_only'] = r['local_only'] == true ? (r['locked'] == true ? 2 : 1) : 0);
      toast(context, r['local_only'] == true ? 'Private: only AI on your devices will answer this chat' : 'Online AI may answer this chat again');
    } catch (e) {
      if (mounted) toast(context, errorText(e), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final lo = (_conv?['local_only'] as num?)?.toInt() ?? 0;
    return Scaffold(
      appBar: AppBar(
        title: Text('${_conv?['title'] ?? 'Chat'}', maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(
            tooltip: lo == 2 ? 'This chat used content you keep on your devices, so it stays private' : lo == 1 ? 'Private: only AI on your devices' : 'Make this chat private',
            isSelected: lo > 0,
            icon: const Icon(Icons.lock_open_outlined),
            selectedIcon: Icon(Icons.lock, color: cs.primary),
            onPressed: lo == 2 ? null : _togglePrivate,
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? ErrorPanel(error: _error!, retry: () { setState(() { _loading = true; _error = null; }); _load(); })
              : Column(children: [
                  if (_modelLabel != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Tooltip(message: _modelReason ?? '', child: Chip(visualDensity: VisualDensity.compact, avatar: const Icon(Icons.auto_awesome, size: 16), label: Text(_modelLabel!, style: const TextStyle(fontSize: 12)))),
                      ),
                    ),
                  Expanded(
                    child: _messages.isEmpty && _streaming == null
                        ? Center(child: Text('Ask ${AppState.of(context).assistantName} anything.', style: TextStyle(color: cs.onSurfaceVariant)))
                        : ListView(
                            controller: _scroll,
                            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
                            children: [
                              for (final (i, m) in _messages.indexed) _Bubble(m, onAnswer: i == _messages.length - 1 && _streaming == null ? _send : null),
                              if (_streaming != null) _Bubble(_streaming!, streaming: true),
                            ],
                          ),
                  ),
                  if (_voiceMode)
                    Material(
                      color: cs.primaryContainer,
                      child: ListTile(
                        leading: Icon(_speaking ? Icons.volume_up : _dict!.listening ? Icons.mic : Icons.hourglass_top, color: cs.onPrimaryContainer),
                        title: Text(_speaking ? 'Speaking…' : _dict!.listening ? (_dict!.interim.isEmpty ? 'Listening…' : _dict!.interim) : _streaming != null ? 'Thinking…' : 'Tap the mic to talk', style: TextStyle(color: cs.onPrimaryContainer)),
                        subtitle: _dict!.error != null ? Text(_dict!.error!, style: TextStyle(color: cs.error)) : null,
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          if (!_dict!.listening && !_speaking && _streaming == null) IconButton(tooltip: 'Talk', onPressed: _dict!.start, icon: const Icon(Icons.mic)),
                          TextButton(onPressed: _toggleVoiceMode, child: const Text('End voice')),
                        ]),
                      ),
                    ),
                  _Composer(
                    controller: _input,
                    busy: _streaming != null,
                    onSend: _send,
                    onStop: _stop,
                    files: _files,
                    uploading: _uploading,
                    onAttach: _attach,
                    onRemove: (f) => setState(() => _files.remove(f)),
                    dictation: _voiceOn && !_voiceMode ? _dict : null,
                    onVoiceMode: _voiceOn && !_voiceMode ? _toggleVoiceMode : null,
                  ),
                  if (lo > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text('🔒 Private chat: answered only by AI on your devices', style: Theme.of(context).textTheme.bodySmall?.copyWith(color: cs.primary)),
                    ),
                ]),
    );
  }
}

const _toolNames = {
  'create_task': 'Adding a to-do', 'update_task': 'Updating a to-do', 'complete_task': 'Completing a to-do', 'create_reminder': 'Setting a reminder',
  'save_memory': 'Remembering', 'web_search': 'Searching the web', 'search_knowledge': 'Looking through your notes', 'log_expense': 'Logging spending',
  'get_daily_overview': 'Reading your day', 'list_tasks': 'Checking your to-dos', 'recall_memories': 'Recalling', 'read_local_file': 'Reading a file',
};

class _Bubble extends StatelessWidget {
  final Msg m;
  final bool streaming;
  /// Set on the latest reply: answering a question card sends the answer as the next message.
  final void Function([String?])? onAnswer;
  const _Bubble(this.m, {this.streaming = false, this.onAnswer});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final user = m.role == 'user';
    final body = user
        ? Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            if (m.attachments.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Wrap(spacing: 6, runSpacing: 6, alignment: WrapAlignment.end, children: [
                  for (final a in m.attachments)
                    a['kind'] == 'image'
                        ? ClipRRect(borderRadius: BorderRadius.circular(10), child: ApiImage('/documents/${a['id']}/preview', width: 140, height: 140))
                        : Chip(visualDensity: VisualDensity.compact, avatar: const Icon(Icons.attach_file, size: 14), label: Text('${a['filename'] ?? 'Attachment'}', style: const TextStyle(fontSize: 12))),
                ]),
              ),
            Text(m.content, style: TextStyle(color: cs.onPrimaryContainer)),
          ])
        : MarkdownBody(
            data: m.content,
            selectable: !streaming,
            onTapLink: (text, href, title) {
              final u = href == null ? null : Uri.tryParse(href);
              if (u != null && (u.scheme == 'https' || u.scheme == 'http' || u.scheme == 'mailto' || u.scheme == 'tel')) {
                launchUrl(u, mode: LaunchMode.externalApplication);
              }
            },
          );
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * (user ? 0.8 : 0.92)),
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4),
          padding: user ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10) : const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          decoration: user ? BoxDecoration(color: cs.primaryContainer, borderRadius: BorderRadius.circular(18)) : null,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (streaming && m.content.isEmpty) _Working(m.tools),
            for (final t in m.tools)
              if (t['name'] == 'ask_user' && t['result'] is Map) _AskCard(t['result'] as Map, onAnswer: onAnswer) else _ToolLine(t),
            body,
            if (!user && !streaming && m.model != null)
              Padding(padding: const EdgeInsets.only(top: 4), child: Text(m.model!, style: Theme.of(context).textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant))),
          ]),
        ),
      ),
    );
  }
}

class _ToolLine extends StatelessWidget {
  final Map<String, dynamic> t;
  const _ToolLine(this.t);

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final status = '${t['status']}';
    final name = _toolNames['${t['name']}'] ?? '${t['name']}'.replaceAll('_', ' ');
    final (icon, color, text) = switch (status) {
      'running' => (Icons.hourglass_top, cs.onSurfaceVariant, '$name…'),
      'executed' => (Icons.check_circle, Colors.green, '${t['summary'] ?? name}'),
      'pending_approval' => (Icons.pan_tool_outlined, Colors.orange, 'Waiting for your OK: ${t['summary'] ?? name}'),
      _ => (Icons.error_outline, cs.error, '${t['summary'] ?? name}: ${t['error'] ?? 'didn’t work'}'),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: InkWell(
        onTap: status == 'pending_approval' ? () => openPath(context, '/actions') : null,
        child: Row(children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Flexible(child: Text(text, style: Theme.of(context).textTheme.bodySmall?.copyWith(color: color == Colors.green ? cs.onSurfaceVariant : color))),
          if (status == 'pending_approval') const Icon(Icons.chevron_right, size: 16),
        ]),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final bool busy;
  final void Function([String?]) onSend;
  final VoidCallback onStop;
  final List<Map> files;
  final bool uploading;
  final VoidCallback onAttach;
  final void Function(Map file) onRemove;
  final Dictation? dictation;
  final VoidCallback? onVoiceMode;
  const _Composer({required this.controller, required this.busy, required this.onSend, required this.onStop, required this.files, required this.uploading, required this.onAttach, required this.onRemove, this.dictation, this.onVoiceMode});

  @override
  Widget build(BuildContext context) {
    final d = dictation;
    final cs = Theme.of(context).colorScheme;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 12, 8),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (files.isNotEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Wrap(spacing: 6, children: [
                for (final f in files)
                  InputChip(
                    avatar: f['kind'] == 'image' ? ClipRRect(borderRadius: BorderRadius.circular(4), child: ApiImage('/documents/${f['id']}/preview', width: 24, height: 24)) : const Icon(Icons.attach_file, size: 16),
                    label: Text('${f['filename']}', overflow: TextOverflow.ellipsis),
                    onDeleted: () => onRemove(f),
                    deleteButtonTooltipMessage: 'Remove ${f['filename']}',
                  ),
              ]),
            ),
          if (d != null && (d.listening || d.error != null))
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(left: 8, bottom: 2),
                child: Text(d.listening ? (d.interim.isEmpty ? '● Listening…' : '● ${d.interim}') : d.error!, style: TextStyle(fontSize: 12, color: d.listening ? cs.primary : cs.error)),
              ),
            ),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            IconButton(
              tooltip: 'Attach a photo, PDF, Word, text, CSV or Excel file',
              onPressed: uploading || files.length >= 5 ? null : onAttach,
              icon: uploading ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.attach_file),
            ),
            if (d != null)
              IconButton(
                tooltip: d.listening ? 'Stop recording' : 'Voice input',
                isSelected: d.listening,
                onPressed: d.listening ? d.stop : d.start,
                icon: const Icon(Icons.mic_none),
                selectedIcon: Icon(Icons.stop_circle_outlined, color: cs.error),
              ),
            Expanded(
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 6,
                textInputAction: TextInputAction.newline,
                decoration: InputDecoration(hintText: 'Message ${AppState.of(context).assistantName}…'),
              ),
            ),
            if (onVoiceMode != null && !busy) IconButton(tooltip: 'Talk hands-free (voice mode)', onPressed: onVoiceMode, icon: const Icon(Icons.record_voice_over_outlined)),
            const SizedBox(width: 4),
            busy
                ? IconButton.filledTonal(onPressed: onStop, icon: const Icon(Icons.stop_rounded), tooltip: 'Stop')
                : IconButton.filled(onPressed: () => onSend(), icon: const Icon(Icons.arrow_upward_rounded), tooltip: 'Send'),
          ]),
        ]),
      ),
    );
  }
}

/// A question from Carino with answers to tap (and an "other" box when allowed).
class _AskCard extends StatefulWidget {
  final Map q;
  final void Function([String?])? onAnswer;
  const _AskCard(this.q, {this.onAnswer});
  @override
  State<_AskCard> createState() => _AskCardState();
}

class _AskCardState extends State<_AskCard> {
  final _picked = <String>{};
  final _other = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final q = widget.q;
    final cs = Theme.of(context).colorScheme;
    final options = ((q['options'] as List?) ?? const []).map((e) => '$e').toList();
    final multiple = q['multiple'] == true;
    final active = widget.onAnswer != null;
    void send(String answer) => widget.onAnswer?.call(answer);
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      color: cs.secondaryContainer.withValues(alpha: 0.5),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${q['question']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final o in options)
              multiple
                  ? FilterChip(label: Text(o), selected: _picked.contains(o), onSelected: active ? (v) => setState(() => v ? _picked.add(o) : _picked.remove(o)) : null)
                  : ActionChip(label: Text(o), onPressed: active ? () => send(o) : null),
          ]),
          if (q['allow_other'] == true && active)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: TextField(
                controller: _other,
                decoration: const InputDecoration(hintText: 'Something else…', isDense: true),
                onSubmitted: (v) { if (v.trim().isNotEmpty) send(v.trim()); },
              ),
            ),
          if (multiple && active)
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.tonal(
                onPressed: _picked.isEmpty && _other.text.trim().isEmpty ? null : () => send([..._picked, if (_other.text.trim().isNotEmpty) _other.text.trim()].join(', ')),
                child: const Text('Send'),
              ),
            ),
        ]),
      ),
    );
  }
}

/// While a reply is on its way: what Carino is busy with, in plain words.
class _Working extends StatefulWidget {
  final List<Map<String, dynamic>> tools;
  const _Working(this.tools);
  @override
  State<_Working> createState() => _WorkingState();
}

class _WorkingState extends State<_Working> {
  static const _phrases = {
    'web': ['Looking it up', 'Reading a few sources', 'Checking the details'],
    'plan': ['Checking your day', 'Lining things up', 'Working out the timing'],
    'write': ['Drafting', 'Choosing the words', 'Tidying it up'],
    'think': ['Thinking', 'Working it out', 'Nearly there'],
  };
  int _i = 0;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(milliseconds: 1800), (_) => setState(() => _i++));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final running = widget.tools.where((t) => t['status'] == 'running').map((t) => '${t['name']}').firstOrNull ?? '';
    final kind = running.contains('search') || running.contains('page') || running.contains('places')
        ? 'web'
        : running.contains('task') || running.contains('remind') || running.contains('calendar') || running.contains('overview')
            ? 'plan'
            : running.contains('send') || running.contains('draft') || running.contains('email')
                ? 'write'
                : 'think';
    final list = _phrases[kind]!;
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: cs.primary)),
        const SizedBox(width: 8),
        Text('${list[_i % list.length]}…', style: TextStyle(color: cs.onSurfaceVariant, fontStyle: FontStyle.italic)),
      ]),
    );
  }
}
