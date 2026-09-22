# 自動テストの対応

`tests/verification-contracts.<domain>.json` を確認項目の唯一の参照元とします。手動チェックリストは廃止しました。各観測は次のいずれかへ分類します。

| 状態 | 意味 |
| --- | --- |
| `automated` | 同じ利用者観測を決定的に再現する。収集・実行・成功を照合するテストIDを記録する。 |
| `retired` | 自動化不能な実環境観測や検証方針から除外した観測。元IDと観測内容を保ち、個別の `retirementReason` を記録する。自動検証済みとは扱わない。 |

## 現在の内訳

| 分野 | 自動 | 手動 | 対象外 | 合計 |
| --- | ---: | ---: | ---: | ---: |
| 起動・読み込み・一覧・プロジェクト | 216 | 0 | 19 | 235 |
| 描画・境界・候補・表示・履歴 | 172 | 0 | 2 | 174 |
| 検出・モデル・設定・ショートカット | 203 | 0 | 18 | 221 |
| 保存・書き出し・異常時・リリース | 122 | 0 | 16 | 138 |
| 通信・対象の組合せ・プロジェクトデータ | 473 | 0 | 5 | 478 |
| 画像反転・保存形式・メタ情報 | 150 | 0 | 3 | 153 |
| **合計** | **1,336** | **0** | **63** | **1,399** |

件数は契約JSONの `observations[].status` から集計した値です。変更時はこの表も同じコミットで更新します。

ブラシの円外保持と候補枠プレビューの取消は `test_editor_brush_padding_e2e.cjs` で、合成画像・実ポインタードラッグ・実Worker出力・保存用PNG・Undoを画素単位で照合する。候補枠の長押しは押下中の複数回の輪郭更新、最新値の確定、失敗時の復元、操作中断時の停止を自動確認する。ブラシ径1〜300pxとShiftホイールの上下限は `test_editor_basic_tools_e2e.cjs` で表示・カーソル・値を確認する。

`test_editor_gesture_live_browser.py` は実ブラウザーのクリック・ドラッグを実HTTP、SQLite履歴、PNG保存まで通し、候補枠取消、4種の手描き、Undo・Redo、PJ再開直後の再編集とUndo、元画像不変を画素単位で照合する。

4K画像の描画は `test_mosaic_4k_e2e.cjs` で確認する。候補と除外を重ねた状態のブラシ描画、変更領域だけの読み取り、近傍タイルだけの取消用保持、取消後の画素と状態の復元を実Chromiumで検証し、ED-106.1 に対応させる。物理CPU・RAMの継続測定である ED-106.2 は対象外のまま区別する。

## 自動化と対象外の境界

実GPU・配布モデル・OS所有のダイアログ・実UNCや物理ドライブ障害・実メモリ枯渇・主観的な操作感は、自動で同じ観測を保証できない残りだけを対象外としました。アプリが受け取る許可・拒否・読込失敗・容量不足などの決定的な処理は自動テストに残します。公開Releaseのタグ・ZIP・版・マージ後SHAは、リリース実施時に公開状態を照合します。

今回残存項目を再点検し、次の決定的な境界を追加・補強しました。

| 元ID | 自動テストで確認する観測 |
| --- | --- |
| SD-012 | 設定を実ファイルへ保存し、StudioStateを終了・再生成して全設定値を復元する。 |
| SD-019 | 各並列数で400件を2回保存し、reserve・render・commitが各対象に1回ずつ行われ、設定値を保持する。 |
| WS-129.4 | 小さいPNG・JPEG・WebPでPillow上限超過経路を再現し、警告なしの一覧・画像・サムネイルと回転JPEGの向きを確認する。巨大画像の物理RAM負荷は対象外のまま区別する。 |
| SV-073.2 | 実ChromiumがHTTP応答を読み取り始めた後に画像の版を変更し、応答全体のハッシュ・画像寸法・一時ファイル解放・古い版のエラー表示を確認する。 |
| SV-077.2 | 実ChromiumとOPFSで元画像の読み取りを失敗させ、専用エラーの表示と元画像・コピー・候補・手描き・一覧の保持を確認する。 |

以前の統合で欠けていた設定・検出の13件とフォルダー走査1件のテスト、および2件の補助メソッドを元の実装から復元し、改名されたテストIDも実際の実行IDへ合わせています。

## 契約の検証

```powershell
node --test tests/test_verification_contracts.cjs
```

この検証は、基準コミット `264f70d` の全確認IDと物理行数をGitから読み直し、契約の重複・欠落、理由のない対象外項目、残存する手動項目や確認文書を検出します。通常実行とCIでは、`automated` が参照するNode・Pythonテストが収集・実行され、失敗・skip・TODOではなく成功したことを実行結果のmanifestで照合します。現在の確認文書が削除済みでも、基準コミットの検証は省略しません。

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

`tests/test_settings_import_regressions.py` と `tests/test_import_drop_contract.cjs` は、SD-011・013・018・149、WS-012・013・137へ対応する。消えた既定保存先と新しい未作成の絶対パスを保った設定保存、相対パス・NULの拒否、初期化、実保存時の拒否、File/handle両経路、端数ミリ秒、失敗後の再取り込みを検証する。実HTTP・SQLiteとChromiumを接続した試験で、設定保存・色許容範囲・全画像検出の要求・ファイル選択・ドロップ・パス入力を操作する。推論要求だけはGPU境界で応答を代替し、設定と取り込みのHTTPは代替しない。

画像ごとの取り込み応答は一覧世代だけを読み、一覧全体は最後の要求で一度取得する。32枚のHTTP試験で全画像の識別情報・mtimeと世代を確認し、画像ごとに一覧全体を作成しないことを固定する。256枚の小PNG・逐次HTTP・通常のSQLite同期によるローカル計測では、旧処理を再現した比較が8.481秒・一覧作成257回、新処理が7.022秒・1回だった。これは当該fixtureの測定値であり、大画像や実ドライブ全般の所要を保証しない。
個別の検出設定は、保存・取消し・保存失敗・再読込後の実行値と一括設定の保持を実ブラウザーで確認します。モデル準備の表示は実HTTP・ジョブ処理とCPUのモデル境界fixtureを通し、準備、一時停止、再開、推論、追加モデル準備、完了、失敗、取消しを確認します。表示契約に実GPUや利用者の画像は必要ありません。
確認フラグの編集後保持と一覧専用削除は `test_review_list_removal_e2e.cjs` のブラウザー操作、`test_project_catalog_lifecycle.py` の元画像保持・再起動、`test_workspace.py` の旧履歴復元で確認する。WS-027・WS-029・WS-036 と DI-051〜053・DI-088〜097・DI-255 の契約を対応させ、実機確認項目は追加しない。

元画像の変更検知・同寸法の受け入れ・範囲の拡縮・クリア・PJへの移行でも、確認済み／未確認の両方を維持する。WS-027 のPython契約で再起動と全履歴のUndo/Redoまで確認する。

一般設定の検証・保存は、検出ダイアログの取消し後も保存済みの対象を使うことを確認します。

設定保存・初期化では保存先の存在や書込み可否を検査しない。`test_settings_save_validates_once_without_probing_output_directory` は更新の検証が一度で、既存の原子的書込みだけが一時ファイルを作ることを確認する。`test_settings_reset_removes_override_without_probing_output_directory` は初期化時に保存先への試し書きを行わないことを確認する。実保存とフォルダー選択時の検証は維持する。
