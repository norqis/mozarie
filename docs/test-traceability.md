# 自動テストと実機確認の対応

`tests/verification-contracts.<domain>.json` を確認項目の唯一の参照元とします。各観測は次のいずれかへ分類します。

| 状態 | 意味 |
| --- | --- |
| `automated` | CIで同じ利用者観測を決定的に再現する。実行するテストIDを契約に記録する。 |
| `manual` | 外部機器、OS、実ファイル、実ネットワークなどが必要で、CIでは同じ観測を再現できない。各分野の実機確認文書にだけ残す。 |
| `retired` | 精度評価やOSダイアログの目視など、確認対象から除外した観測。実機確認文書には残さない。 |

## 現在の内訳

| 分野 | 自動 | 実機 | 対象外 | 合計 |
| --- | ---: | ---: | ---: | ---: |
| 起動・読み込み・一覧・プロジェクト | 213 | 19 | 0 | 232 |
| 描画・境界・候補・表示・履歴 | 172 | 2 | 0 | 174 |
| 検出・モデル・設定・ショートカット | 203 | 9 | 9 | 221 |
| 保存・書き出し・異常時・リリース | 120 | 14 | 4 | 138 |
| 通信・対象の組合せ・プロジェクトデータ | 473 | 4 | 1 | 478 |
| 画像反転・保存形式・メタ情報 | 150 | 2 | 1 | 153 |
| **合計** | **1,331** | **50** | **15** | **1,396** |

件数は契約JSONの `observations[].status` から集計した値です。変更時はこの表も同じコミットで更新します。

ブラシの円外保持と候補枠プレビューの取消は `test_editor_brush_padding_e2e.cjs` で、合成画像・実ポインタードラッグ・実Worker出力・保存用PNG・Undoを画素単位で照合する。候補枠の長押しは押下中の複数回の輪郭更新、最新値の確定、失敗時の復元、操作中断時の停止を自動確認する。ブラシ径1〜300pxとShiftホイールの上下限は `test_editor_basic_tools_e2e.cjs` で表示・カーソル・値を確認する。

## 実機確認として残す範囲

残る項目は次の外部環境に限ります。具体的な観測内容は [実機確認の索引](manual-verification.md) から各分野の文書を参照してください。

- 実GPU、配布モデル、ONNX Runtimeやドライバーを含む実行環境
- OSが管理するファイル権限、ブラウザーのFile System Access、実フォルダー
- 実ドライブの容量不足、UNC・SMB・FAT、通信切断
- 公開Release、配布ZIP、セットアップ、更新経路
- 実際のメモリ不足、VRAM解放、4K・大量画像・長時間操作の応答性

検出精度、候補数の最低値、OS権限ダイアログ自体の目視は確認対象に含めません。

ブラウザー保存の権限は `tests/test_browser_save_runtime.cjs` でフォルダー配下の複数画像・反復保存・単独ファイルの再許可・拒否・権限失効・操作権限の失効を検証します。`tests/test_folder_permissions_e2e.cjs` は取り込みと再読み込みでルートと直接の親フォルダーを保持することを確認します。OSの許可画面は操作しません。

同じ保存契約テストで、小数ミリ秒のファイル更新日時を再読み込み後も比較でき、保存APIへ整数ミリ秒で送ること、元画像の読み取り失敗を専用のエラーとして表示し、書き込みを開始しないことを確認します。

製品サイトの用途・検出対象・検索用説明・共有用メタ情報は `scripts/test-site.cjs` で、既存の画面画像、Google検証と計測、320〜1920pxの表示、JavaScript無効時の本文と合わせて検証します。

## 契約の検証

```powershell
node --test tests/test_verification_contracts.cjs
```

この検証は、基準コミットの全確認IDが `automated`・`manual`・`retired` のいずれかに一度だけ割り当てられていること、実機確認文書に `manual` 以外の行が残っていないこと、重複や欠落がないことを確認します。CIではさらに、`automated` が参照するNode・Pythonテストが収集・実行され、skipやTODOではなく成功したことを実行結果のmanifestで照合します。

## 上部ツールのショートカット

追加した操作と設定表示は隔離したChromiumで検証する。実機確認項目は追加しない。

| 利用者が確認する挙動 | 自動テスト |
| --- | --- |
| 全描画ツールの個別キー、Q/Wの左右順・グループ移動・長押し抑止、塗りつぶしポップアップ後のフォーカス | `tests/test_toolbar_shortcuts_e2e.cjs` の `toolbar shortcuts select every drawing mode and cycle each group in visible order` |
| 1/2枚表示・全体表示・反転・モザイク表示・Undo/Redo | 同ファイルの `toolbar view fit flip preview and history shortcuts perform their visible actions` |
| 操作別と全体のOFF、入力中・ダイアログ・処理中・閲覧専用・無効ボタン・画像切替・描画中の抑止 | 同ファイルの `toolbar shortcuts obey per-action global focus modal busy and disabled controls` |
| キー欄の右側のON/OFFスイッチ、右端揃え・下線・交互背景、Tab移動、変更と再読み込み | 同ファイルの `shortcut switches align after key inputs and preserve remapped disabled bindings after reload` |
| 旧設定の独自キーと有効状態を保持し、新キーの衝突時は未使用キーをOFFで追加、重複保存拒否 | `tests.test_config.SettingsTests.test_toolbar_shortcuts_defaults_are_complete_unique_and_round_trip`、`test_toolbar_shortcuts_migrate_without_claiming_custom_keys` |

## 設定・ブラウザー取り込みの回帰境界

`tests/test_settings_import_regressions.py` と `tests/test_import_drop_contract.cjs` は、SD-011・013・018・149、WS-012・013・137へ対応する。消えた既定保存先を保った設定保存、変更先の検証、初期化、実保存時の拒否、File/handle両経路、端数ミリ秒、失敗後の再取り込みを検証する。実HTTP・SQLiteとChromiumを接続した試験で、設定保存・色許容範囲・全画像検出の要求・ファイル選択・ドロップ・パス入力を操作する。推論要求だけはGPU境界で応答を代替し、設定と取り込みのHTTPは代替しない。

画像ごとの取り込み応答は一覧世代だけを読み、一覧全体は最後の要求で一度取得する。32枚のHTTP試験で全画像の識別情報・mtimeと世代を確認し、画像ごとに一覧全体を作成しないことを固定する。256枚の小PNG・逐次HTTP・通常のSQLite同期によるローカル計測では、旧処理を再現した比較が8.481秒・一覧作成257回、新処理が7.022秒・1回だった。これは当該fixtureの測定値であり、大画像や実ドライブ全般の所要を保証しない。
個別の検出設定は、保存・取消し・保存失敗・再読込後の実行値と一括設定の保持を実ブラウザーで確認します。モデル準備の表示は実HTTP・ジョブ処理とCPUのモデル境界fixtureを通し、準備、一時停止、再開、推論、追加モデル準備、完了、失敗、取消しを確認します。表示契約に実GPUや利用者の画像は必要ありません。
