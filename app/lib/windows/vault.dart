import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';

import 'host.dart';

/// Seals Carino's master key with Windows' Data Protection API (DPAPI): only this Windows user
/// account on this PC can open it again. Same entropy as the earlier app, so keys it sealed still
/// open. The key is passed in and out as base64.
final class _Blob extends Struct {
  @Uint32()
  external int cbData;
  external Pointer<Uint8> pbData;
}

typedef _CryptNative = Int32 Function(Pointer<_Blob>, Pointer<Utf16>, Pointer<_Blob>, Pointer<Void>, Pointer<Void>, Uint32, Pointer<_Blob>);
typedef _CryptDart = int Function(Pointer<_Blob>, Pointer<Utf16>, Pointer<_Blob>, Pointer<Void>, Pointer<Void>, int, Pointer<_Blob>);
typedef _CryptUnprotectNative = Int32 Function(Pointer<_Blob>, Pointer<Pointer<Utf16>>, Pointer<_Blob>, Pointer<Void>, Pointer<Void>, Uint32, Pointer<_Blob>);
typedef _CryptUnprotectDart = int Function(Pointer<_Blob>, Pointer<Pointer<Utf16>>, Pointer<_Blob>, Pointer<Void>, Pointer<Void>, int, Pointer<_Blob>);

const _uiForbidden = 0x1;
final _entropy = utf8.encode('carino-vault-v1');

Uint8List _run(Uint8List input, bool protect) {
  if (!Platform.isWindows) throw const HostError('unsupported');
  final crypt32 = DynamicLibrary.open('crypt32.dll');
  final kernel32 = DynamicLibrary.open('kernel32.dll');
  final localFree = kernel32.lookupFunction<Pointer<Void> Function(Pointer<Void>), Pointer<Void> Function(Pointer<Void>)>('LocalFree');
  return using((arena) {
    Pointer<_Blob> blob(List<int> bytes) {
      final data = arena<Uint8>(bytes.isEmpty ? 1 : bytes.length)..asTypedList(bytes.length).setAll(0, bytes);
      return arena<_Blob>()
        ..ref.cbData = bytes.length
        ..ref.pbData = data;
    }

    final inp = blob(input);
    final ent = blob(_entropy);
    final out = arena<_Blob>();
    final ok = protect
        ? crypt32.lookupFunction<_CryptNative, _CryptDart>('CryptProtectData')(inp, nullptr, ent, nullptr, nullptr, _uiForbidden, out)
        : crypt32.lookupFunction<_CryptUnprotectNative, _CryptUnprotectDart>('CryptUnprotectData')(inp, nullptr, ent, nullptr, nullptr, _uiForbidden, out);
    if (ok == 0) throw const HostError('Windows could not protect or open the saved key.');
    final copy = Uint8List.fromList(out.ref.pbData.asTypedList(out.ref.cbData));
    localFree(out.ref.pbData.cast());
    return copy;
  });
}

String vaultSeal(String plainB64) => base64Encode(_run(base64Decode(plainB64), true));
String vaultOpen(String sealedB64) => base64Encode(_run(base64Decode(sealedB64), false));
