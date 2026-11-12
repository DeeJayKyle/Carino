import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

/// The engine's WebView, placed on screen so its own web screens can be shown (Android only).
/// It always stays in the tree: Flutter screens draw over it, and a web screen's page is see-through.
class EngineView extends StatelessWidget {
  const EngineView({super.key});

  static const viewType = 'carino/engine-view';

  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.android) return const SizedBox.shrink();
    return PlatformViewLink(
      viewType: viewType,
      surfaceFactory: (context, controller) => AndroidViewSurface(
        controller: controller as AndroidViewController,
        gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new)},
        hitTestBehavior: PlatformViewHitTestBehavior.opaque,
      ),
      onCreatePlatformView: (params) => PlatformViewsService.initExpensiveAndroidView(
        id: params.id,
        viewType: viewType,
        layoutDirection: TextDirection.ltr,
        creationParamsCodec: const StandardMessageCodec(),
        onFocus: () => params.onFocusChanged(true),
      )
        ..addOnPlatformViewCreatedListener(params.onPlatformViewCreated)
        ..create(),
    );
  }
}
