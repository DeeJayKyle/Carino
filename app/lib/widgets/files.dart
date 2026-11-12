import 'package:file_picker/file_picker.dart';

import '../engine/engine.dart';

/// Lets the user choose files (and reads them) for uploading to Carino.
Future<List<Upload>> pickUploads({bool multiple = false, Map<String, String> fields = const {}, FileType type = FileType.any}) async {
  final picked = multiple ? await FilePicker.pickFiles(type: type) : [?(await FilePicker.pickFile(type: type))];
  return [for (final f in picked) Upload(name: f.name, mime: mimeFor(f.name), bytes: await f.readAsBytes(), fields: fields)];
}

String mimeFor(String name) {
  final ext = name.split('.').last.toLowerCase();
  return const {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp', 'gif': 'image/gif', 'heic': 'image/heic',
        'pdf': 'application/pdf', 'txt': 'text/plain', 'md': 'text/markdown', 'csv': 'text/csv',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'mp4': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm', 'm4a': 'audio/mp4', 'mp3': 'audio/mpeg', 'ogg': 'audio/ogg', 'wav': 'audio/wav',
      }[ext] ??
      'application/octet-stream';
}
