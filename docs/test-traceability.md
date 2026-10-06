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

ED-114.2 の画像間の手描き・履歴保持は `editor/test_draft_transition_e2e.cjs` でも確認する。実ChromiumのPNG変換を保留して画像を往復・連続選択し、変換完了まで元画像を維持して最後の選択だけを表示する。変換失敗時は選択・画素を保ち、追加・除外・除外消去の変更領域と履歴基底を再試行へ引き継ぎ、再選択後の画素とUndo・Redoを照合する。履歴を持たないAPI応答には空の履歴を捏造せず、3層PNGをローカル履歴の基底にする。通常の無名・名前付き作業はともに永続履歴を使い、`test_editor_gesture_live_browser.py` で実HTTP・SQLiteを通した連続選択、3層の初回表示、初編集のUndo・Redo、ページ再読込後の画素保持を確認する。

WS-039.1 の一覧絞り込みメニューは `test_workspace_contract_browser.cjs` で、420×760 px の表示域でもボタン直下に開き、横にはみ出さないことを確認する。

4K画像の描画は `test_mosaic_4k_e2e.cjs` で確認する。候補と除外を重ねた状態のブラシ描画、変更領域だけの読み取り、近傍タイルだけの取消用保持、取消後の画素と状態の復元を実Chromiumで検証し、ED-106.1 に対応させる。物理CPU・RAMの継続測定である ED-106.2 は対象外のまま区別する。

SV-072.1、DI-071.1、DI-072.1 の画像所有は `test_resources.cjs` と `resources/test_browser_resource_lifecycle.cjs` で確認する。画像未選択・ホバーなしでは全画像Bitmapと候補Bitmapを解放し、ホバー中だけ対象の1枚を保持する。選択解除、保存後の一覧更新、失効の各経路で旧Bitmapを閉じ、再選択後の描画も実Chromiumで確認する。

## 自動化と対象外の境界

実GPU・配布モデル・OS所有のダイアログ・実UNCや物理ドライブ障害・実メモリ枯渇・主観的な操作感は、自動で同じ観測を保証できない残りだけを対象外としました。アプリが受け取る許可・拒否・読込失敗・容量不足などの決定的な処理は自動テストに残します。公開Releaseのタグ・ZIP・版・マージ後SHAは、リリース実施時に公開状態を照合します。

今回残存項目を再点検し、次の決定的な境界を追加・補強しました。

| 元ID | 自動テストで確認する観測 |
| --- | --- |
| SD-012 | 設定を実ファイルへ保存し、StudioStateを終了・再生成して全設定値を復元する。 |
| SD-019 | 各並列数で400件を2回コピー保存し、reserve・render・commitが各対象に1回ずつ行われ、設定値を保持する。ブラウザー元画像への上書きは設定した並列数まで異なるファイルのsnapshotと書き込みを重ね、コピー後削除も全件共通の待ち行列に入れない。同じ取込元の別フォルダーに同名画像が400件あってもhandle同一性の総当たりを行わず全件の書込・commitを完了する。異なる取込元や取込情報不足ではhandle同一性を照会し、同じ元ファイルの別handle、同じ親フォルダーの改名先重複、別画像の元ファイル名との衝突は出力前に拒否する。異なる親フォルダーの同名出力は許可し、失敗時は対象ファイルだけ復元する。 |
| WS-129.4 | 小さいPNG・JPEG・WebPでPillow上限超過経路を再現し、警告なしの一覧・画像・サムネイルと回転JPEGの向きを確認する。巨大画像の物理RAM負荷は対象外のまま区別する。 |
| SV-073.2 | 実ChromiumがHTTP応答を読み取り始めた後に画像の版を変更し、応答全体のハッシュ・画像寸法・一時ファイル解放・古い版のエラー表示を確認する。 |
| SV-077.2 | 実ChromiumとOPFSで元画像の読み取りを失敗させ、専用エラーの表示と元画像・コピー・候補・手描き・一覧の保持を確認する。 |
| SV-075.2・SV-087.3 | `tests/saving/test_apply_staging_failures.py` は公開保存ジョブにOSのディレクトリ作成・一時ファイル作成・同期失敗と実SQLiteの登録・stage更新拒否を注入し、専用エラー、一時ファイルと予約の解放、元画像・候補・手描き・履歴の保持、再保存の成功を確認する。コピーのフォルダー構成保持ON/OFFと元画像上書きを対象とする。 |

同ファイルの `test_cleanup_failure_after_commit_keeps_output_and_releases_reservation` は、保存の確定後にサムネイル削除が失敗しても完成したコピーを保持し、出力予約だけを解放することを確認する。

以前の統合で欠けていた設定・検出の13件とフォルダー走査1件のテスト、および2件の補助メソッドを元の実装から復元し、改名されたテストIDも実際の実行IDへ合わせています。

## 検出候補公開の回帰境界

検出候補の公開前の保存処理は `tests/detection/test_candidate_publication.py` の専用一時画像・PNG・SQLite・実ジョブで検証する。モデルの推論結果とファイル書込み・名前変更の故障だけを外部境界で代替し、実GPU・配布モデルの精度は検証対象としない。

| 利用者が確認する挙動 | 自動テスト |
| --- | --- |
| SD-134.2：8×8画像で100pxを指定しても検出を完了し、画像対角の10pxを候補へ反映する。0px・2pxは維持し、設定値・元画像・PNGの元マスクを変えず、SQLiteとUndo/Redoに反映する。 | `CandidatePublicationTests.test_started_detection_clamps_large_padding_and_preserves_saved_setting` |
| 自動検出・境界検出の2個目のPNG書込み途中に失敗すると、完成済みと部分書込みの今回分を除去し、既存候補の実ファイル・SQLite・Redo履歴を保持する。 | `CandidatePublicationTests.test_second_detection_write_discards_complete_and_partial_masks_preserving_history`、`test_second_boundary_write_discards_complete_and_partial_masks_preserving_history` |
| 境界検出の2個目の名前変更に失敗すると、名前変更済みと未変更の今回分を除去し、既存候補と履歴を保持する。 | `CandidatePublicationTests.test_second_boundary_rename_discards_published_and_pending_masks_preserving_history` |
| 自動検出失敗後の一時ファイル削除が拒否されても、他の今回分を除去し、元の書込みエラーと削除失敗を記録する。既存候補と履歴を保持する。 | `CandidatePublicationTests.test_detection_cleanup_failure_logs_without_replacing_original_write_failure` |

PNGのSceneタグ連携は `tests/detection/test_scene_png_metadata.py` で確認する。実PNGの `scene_positive`・`scene_info` をtEXt/zTXtのLatin-1とiTXtのUTF-8（圧縮・非圧縮）から読み、実ジョブの推論要求へ対象を追加する。壊れた任意テキスト・未知の圧縮方式・不正UTF-8はそのチャンクだけ無視し、後続の無効値で直前の有効値や他方のキーを消さない。大文字違い・部分一致・workflowなどの無関係キーは展開せず、精液除外OFFでも展開・連携しない。元PNG、一般画像情報、保存後のテキストチャンクは保持する。推論モデルだけはCPUの外部境界fixtureで代替する。

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
| 全体スイッチのOFFを保存・再読込するとQがツールを切り替えず、ONで再保存すると切り替わる | 同ファイルの `saved global shortcut switch disables and restores real tool keys after reload` |
| キー欄の右側のON/OFFスイッチ、右端揃え・下線・交互背景、Tab移動、変更と再読み込み | 同ファイルの `shortcut switches align after key inputs and preserve remapped disabled bindings after reload` |
| 旧設定の独自キーと有効状態を保持し、新キーの衝突時は未使用キーをOFFで追加、重複保存拒否 | `tests.test_config.SettingsTests.test_toolbar_shortcuts_defaults_are_complete_unique_and_round_trip`、`test_toolbar_shortcuts_migrate_without_claiming_custom_keys` |

## 設定・ブラウザー取り込みの回帰境界

`test_live_drag_handle_overwrites_original_without_parent_picker` は、実HTTP・Chromiumと隔離OPFS上のドラッグ元ファイルで、名前変更なし・元形式の単一／一括上書きを確認する。保存前の名前と形式、親フォルダー選択0回、Windows保存先フォルダー選択API要求0回、通常と800×600表示での保存ボタンと保存先変更ボタンの非重複、クリックとEnterキーでの保存、書込権限要求1回、元ファイルの実バイト更新を照合する。明示的な名前変更をプロジェクトに保存して再読込した場合は、変更名が残り、親フォルダー選択が1回必要になることも確認する。

`tests/test_settings_import_regressions.py` と `tests/test_import_drop_contract.cjs` は、SD-011・013・018・149、WS-012・013・137へ対応する。消えた既定保存先と新しい未作成の絶対パスを保った設定保存、相対パス・NULの拒否、初期化、実保存時の拒否、File/handle両経路、端数ミリ秒、失敗後の再取り込みを検証する。実HTTP・SQLiteとChromiumを接続した試験で、設定保存・色許容範囲・全画像検出の要求・ファイル選択・ドロップ・パス入力を操作する。推論要求だけはGPU境界で応答を代替し、設定と取り込みのHTTPは代替しない。

画像ごとの取り込み応答は一覧世代だけを読み、一覧全体は最後の要求で一度取得する。32枚のHTTP試験で全画像の識別情報・mtimeと世代を確認し、画像ごとに一覧全体を作成しないことを固定する。256枚の小PNG・逐次HTTP・通常のSQLite同期によるローカル計測では、旧処理を再現した比較が8.481秒・一覧作成257回、新処理が7.022秒・1回だった。これは当該fixtureの測定値であり、大画像や実ドライブ全般の所要を保証しない。
個別の検出設定は、保存・取消し・保存失敗・再読込後の実行値と一括設定の保持を実ブラウザーで確認します。モデル準備の表示は実HTTP・ジョブ処理とCPUのモデル境界fixtureを通し、準備、一時停止、再開、推論、追加モデル準備、完了、失敗、取消しを確認します。表示契約に実GPUや利用者の画像は必要ありません。
確認フラグの編集後保持と一覧専用削除は `test_review_list_removal_e2e.cjs` のブラウザー操作、`test_project_catalog_lifecycle.py` の元画像保持・再起動、`test_workspace.py` の旧履歴復元で確認する。WS-027・WS-029・WS-036 と DI-051〜053・DI-088〜097・DI-255 の契約を対応させ、実機確認項目は追加しない。

元画像の変更検知・同寸法の受け入れ・範囲の拡縮・クリア・PJへの移行でも、確認済み／未確認の両方を維持する。WS-027 のPython契約で再起動と全履歴のUndo/Redoまで確認する。

一般設定の検証・保存は、検出ダイアログの取消し後も保存済みの対象を使うことを確認します。
除外の強制適用の既定値は、`tests/test_settings_dialog_e2e.cjs` の `exclusion force default persists and controls untouched images` で、OFF保存・再読込後とON再保存後に、それぞれ未編集の画像へ反映されることを確認する。

設定保存・初期化では保存先の存在や書込み可否を検査しない。`test_settings_save_validates_once_without_probing_output_directory` は更新の検証が一度で、既存の原子的書込みだけが一時ファイルを作ることを確認する。`test_settings_reset_removes_override_without_probing_output_directory` は初期化時に保存先への試し書きを行わないことを確認する。実保存とフォルダー選択時の検証は維持する。

コピー保存先が消えた場合は、個別・一括の保存画面で作成確認を出す。取消しでは保存画面・入力・対象を保ち、ブラウザー権限要求・保存準備・設定書込み・作成を始めない。作成を選んだときだけ現在設定された絶対パスを作り、そのまま保存する。既存の使用可能なフォルダーは従来どおり直接保存し、ファイルや利用不能な場所は作成確認を出さず既存のエラーを表示する。新しいパスを直接入力した後にブラウザー元画像の削除を伴う場合、権限要求をユーザー操作内で始めるため、既存フォルダーなら保存の再押下を案内する。`tests/test_missing_output_directory_e2e.cjs` の個別・一括操作、長いパス表示、再表示時の状態更新、ブラウザー権限境界、`tests.test_settings_import_regressions.SettingsImportRegressionTests.test_missing_output_requires_explicit_create_and_uses_current_configured_path` と `test_unusable_output_is_not_reported_as_missing_or_overwritten` が画面・HTTP・ディスク状態を検証する。

## 大量画像の保存可否判定

SV-015.1 の保存対象表示は、`tests/saving/test_bulk_save_capabilities.cjs` の `20k bulk save dialog and action locks keep capability lookup linear` でも確認する。実Chromiumで2万件の一覧から全保存画面を開き、対象件数、保存開始中の操作ロック、ローカル画像とブラウザー画像が混在する場合のhandle取得・喪失後の上書き可否を照合する。IDの参照回数を件数に比例する境界で検証し、固定時間待機や実行速度の閾値を使わない。

同ファイルの `bulk save capabilities preserve filesystem browser handle missing and empty targets` は、元形式・PNG・JPEG・WebPの上書き／削除可否、空対象、欠損ID、親フォルダーだけのアクセス情報、一覧の置換を検証する。可否表示ではブラウザー権限を問い合わせず、file handleの存在で従来どおり判定する。OSの権限画面自体は検証対象に含めない。

## 細長い画像の検出マスク

`tests/inference/test_segmentation_geometry.py` は、実際の検出入口から前処理・座標復元・重複候補除去・マスク生成を通し、外部推論セッションの出力だけを代替する。実GPUや配布モデルの精度は検証対象に含めない。

| 利用者が確認する挙動 | 自動テスト |
| --- | --- |
| 1×4096・4096×1画像を主検出モデルで処理しても空画像エラーにならず、元画像寸法の候補マスクを返し、検出枠の内側だけに画素を持つ。元RGBを保持する。 | `SegmentationGeometryTests.test_target_detect_preserves_one_pixel_edges_and_constrains_the_mask` |
| 同じ縦横の画像を補助YOLOモデルで処理しても、候補・元寸法・枠内画素・枠外ゼロ・元RGBを保持する。 | `SegmentationGeometryTests.test_generic_detect_preserves_one_pixel_edges_and_constrains_the_mask` |
| 通常比率と256／257ピクセルの非対称余白で、両モデルのマスク位置と検出枠による制限を維持する。 | `SegmentationGeometryTests.test_normal_aspect_and_odd_padding_preserve_mask_position` |

Pillowの依存関係は `tests.test_updater.UpdaterTests.test_requirements_dry_run_contract_covers_every_supported_python_launcher` で確認する。CUDA・CPU・DirectML・テスト用の4プロファイルすべてで `Pillow>=12.3,<13` を指定し、修正済みの最低版と次のメジャー版の境界をそろえる。

## キーボード操作面の契約収集

ED-132.1・ED-132.2 の操作対象は、`test_ui_control_manifest.cjs` でHTML開始タグから収集する。標準のbutton・input・select・textareaに加え、0以上のtabindex、またはseparatorロールを持つ要素を含め、tabindex=-1だけのフォーカス移動先は除外する。小さいHTML fixtureでこの区別と、未登録のキャンバス・分割バーが契約不足として失敗することを確認する。

| 操作面 | 実行結果を照合する既存テスト |
| --- | --- |
| gallerySplitter・candidateSplitter：ポインターと矢印キーによる幅変更、画像・選択・候補の保持 | `test_workspace_splitters_e2e.cjs::workspace pane splitters preserve content and use gesture deltas` |
| compareSplitter：ポインターとキーによる比率変更、上下限、再読込後の保持 | `test_padding_splitter_e2e.cjs::<file>` |
| editorCanvas：実描画操作による各レイヤーの画素変化 | `test_editor_basic_tools_e2e.cjs::basic editor tools keep their pixel-layer contracts` |

4要素は既存の専用試験への対応を`ui-control-manifest.cjs`へ記録し、通常実行とCIで各test IDの収集・実行・成功を照合する。manifest本体の検証IDは `static UI controls have complete executable interaction contracts` とし、ED-132の参照も同時に更新する。
