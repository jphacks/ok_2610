# 顔検出モデル（Issue #11）

画像の中の顔を端末内で見つけるためのモデル。拡張に同梱し（`wxt.config.ts`）、外部には取りに行かない。

| ファイル | 内容 |
|---|---|
| `blaze_face_short_range.tflite` | MediaPipe Face Detector（BlazeFace short range, float16, version 1） |

- 入手元: https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite （MediaPipe 公式の配布先）
- SHA-256: `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`
- ライセンス: Apache License 2.0（MediaPipe）
- 実行には `@mediapipe/tasks-vision`（npm、Apache-2.0）の WASM を使う。WASM は npm のパッケージからビルド時に同梱する
