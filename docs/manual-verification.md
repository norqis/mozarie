# 実機確認

決定的に再現できる確認はすべて自動テストへ移しました。この索引には手順や確認項目を重複して記載しません。

実機確認として残すのは、実GPU・実モデル・OSが管理する権限、実ドライブやネットワーク、本番Release、実際のメモリ不足や長時間操作など、CIで同じ観測を再現できない項目だけです。各分野の文書には、残した理由と必要な環境を項目ごとに記載しています。

- [起動・読み込み・一覧・プロジェクト](manual-verification/workspace.md)
- [描画・境界・候補・表示・履歴](manual-verification/editor.md)
- [検出・モデル・設定・ショートカット](manual-verification/settings-detection.md)
- [保存・書き出し・異常時・リリース](manual-verification/save-release.md)
- [通信・対象の組合せ・プロジェクトデータ](manual-verification/data-integrity.md)
- [画像反転・保存形式・メタ情報](manual-verification/flip-export.md)

自動化、実機確認、対象外の分類と件数は [自動テストとの対応](test-traceability.md) を参照してください。
