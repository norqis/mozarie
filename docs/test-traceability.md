# 自動テストの対応

全体監査8回目では、短い手動操作が250msの保存待ちで一つのUndoへ合流する問題を修正した。ED-085.1・ED-086.1 に実HTTP・SQLite・Chromiumの高速連続stroke、PNG encoder保留、保存通信保留の3試験を追加し、各操作の確定時に画素を捕捉して筆跡・消しゴム・手動ON/OFF・全消去を1操作ずつUndo/Redoできること、再読込後も履歴を維持することを確認する。画像記録と通信のqueueを分け、保存中の描画・画像切替と、成功後の非選択draft解放を既存のブラウザー試験で確認する。全消去のDELETEが失敗した場合は消去前のサーバー画素を再表示せず、現在の空画素を保持して再保存後に画像切替できることを ED-114.2 へ追加した。

全体監査7回目では、ネイティブ単一保存のDB確定失敗を既存の保存ジャーナル復旧へ統一した。`saving/test_native_overwrite_recovery.py` は実ファイルとSQLite triggerで同名・改名・JPG変換を試験し、通常失敗時の元画像復元と再保存、外部更新時の全バイト保持・復旧保留・編集と履歴の保持・ジャーナル再接続後の復旧を SV-080.1・SV-081.1 へ追加した。検出設定のブラウザー試験は検出APIの応答完了を待ってサーバー受信内容を照合する。

全体監査6回目では、ブラウザー経由の元画像上書き中に画面が終了した場合の復旧を SV-080.1・SV-081.1 へ追加した。`saving/test_browser_overwrite_recovery.py` の23試験は実HTTP・SQLite・Chromium・IndexedDB・OPFSを通し、単一／一括、同名／名前変更、サーバー確定前／確定後の画面クラッシュを再現する。未確定なら元画像の全バイトと編集・履歴を保持して再保存でき、確定済みなら巻き戻さず新ファイルを残す。復旧用データの書込・読込・削除、元画像復元、復元後メタデータ更新の失敗でも、再試行に必要なデータとtokenを保持する。二つのタブが同時に復旧しても同じ画像を重複復元しない。クラッシュ後に別操作で元画像・改名先を更新した場合は、その新しい画像を上書き・削除せず復旧情報を保持する。元画像が未変更なら復旧の再書込を省き、保存後情報が未確定なら巻き戻さずbackupを保持する。改名先または旧名が既に消えていても復旧を完了する。保存対象と取込元が一致しないメタデータ更新は拒否し、別画像・確認状態・編集を変更しない。実GPU・Windowsダイアログ・実ファイルシステム権限そのものを検証したとは扱わない。

`test_active_save_recovery_e2e.cjs` は復旧にも設定済みの保存並列数を適用し、待機中の応答があっても他画像を処理し、通信失敗したtokenだけを残し、警告と失敗結果を返すこと、再試行成功後に成功結果へ戻ることを確認する。取消し・確認応答の通信失敗でも復旧未完了の警告を優先し、tokenを保持する。WS-101.1 の再起動試験はサーバーが返した取込元IDで再接続し、画像・手描き・履歴を維持したまま次の保存まで成功することを確認する。

全体監査5回目では WS-101.1 に次を追加した。`jobs/test_multi_source_jobs.py` は再開した複数native-folderの画像をそれぞれ単一・一括保存の準備へ渡し、実検出ジョブ・候補公開・一括コピー保存まで通す。外部推論だけを固定マスクに置き換え、全出力の画素と原本保持を確認する。`BrowserSourceReopenTests.test_reconnecting_in_the_same_session_keeps_edits_and_only_one_staged_image` は、file/directory sourceの同一session内での再接続を繰り返し、画像ID・候補・手描き・履歴・編集名を保ち、一時画像を1枚だけ残す。再接続失敗時も旧画像と編集を保持し、通常addの同名拒否は維持する。

SD-039.1・SD-147.1 は `detection/test_tile_merge.py` と `CandidatePublicationTests.test_equal_score_auxiliary_tiles_publish_separate_candidates_and_the_best_duplicate` で、同class・同scoreの離れた候補の後ろに重複候補が来ても、実検出ジョブが完了することを確認する。非重複候補の順序、source優先度、同順位での既存候補保持、複数候補をまたぐ重複、最終公開マスクの全画素を照合する。外部推論だけを固定出力へ置き換え、実モデルの精度確認とは扱わない。

全体監査4回目では、手描き画像とその版を同じ取得応答で渡し、一覧の更新だけで未更新の画素へ新しい版を付けないことを確認した。

ブラウザー保存と全体flushの既存fixtureも、直接設定する下書きへ取得済みの版を対で設定する。保存処理や失敗境界の判定は製品実装を使う。

| 契約 | 追加した観測とテスト |
| --- | --- |
| WS-100.5 | `manual_snapshot_live_browser_helper.cjs` を `LiveEditorGestureBrowserTests` の選択・名前変更・一覧同期・画像追加・他画像削除の5試験から実行する。別タブで編集した非選択画像を読み、続けて描いて両方の画素を保存する。PNG取得・デコード失敗では旧画素と版を保持し、再試行する。一覧更新後の旧画素による保存は競合となり、別タブの画素を保持する。 |
| DI-184.1 | `test_return_sync_refreshes_pixels_after_metadata_already_updated_the_catalog` は、一覧の版が先に更新された後でも復帰時に画素を更新し、そのまま編集を保存できることを確認する。 |
| SV-012.1 | `test_single_copy_rejects_stale_canvas_after_catalog_metadata_refresh` と `test_batch_copy_rejects_stale_draft_after_catalog_metadata_refresh` は、名前変更後も実際に保持する画素の版で描画を要求し、古い手描き状態のファイルを生成しない。 |
| ED-085.1 | `MaskBoundsMemoryTests.test_manual_history_decodes_each_changed_png_once_and_keeps_undo_pixels` はPNGの実デコードが変更前後で各1回であることと、追加・削除・変更の戻す／やり直すが画素単位で一致することを確認する。 |
| ED-114.2 | `LiveHttpEndpointTests.test_manual_png_processing_does_not_block_catalog_reads` はPillowの画像デコード境界で待ち合わせ、手描きPNG処理中も実HTTPの一覧取得が完了し、処理後の画素と版が確定することを確認する。 |

全体監査3回目では、次の実HTTP・SQLite・Chromiumの観測を既存契約へ追加した。手動確認項目は追加しない。

| 契約 | 追加した観測とテスト |
| --- | --- |
| WS-100.5、ED-085.1、ED-086.1 | `manual_sync_live_browser_helper.cjs` を `LiveEditorGestureBrowserTests.test_peer_manual_sync_conflicts_and_last_stroke_undo_use_real_workspace` から実行。別タブの手描き画素を復帰時に表示し、非選択画像の未保存の編集は競合時に保持する。最後の手描き全消去を戻すと全筆跡が戻り、やり直すと空になる。 |
| ED-085.1 | `LiveHttpEndpointTests.test_manual_revision_conflicts_keep_pixels_and_empty_delete_is_undoable` は通常保存・ストリーム確定・削除・履歴復元の版と画素を確認。履歴INSERT失敗では画素と版が共に戻る。 |
| SV-012.1、SV-096.1 | `test_copy_delete_rejects_new_edits_before_commit_and_browser_delete_claim`、`test_render_rejects_a_dialog_draft_from_before_peer_manual_edit` は描画前・描画後・削除予約後の編集を保持する。`test_browser_copy_delete_recovery_keeps_edits_made_after_the_copy` はIndexedDBに残したコピー時の版を再開時にも使い、元画像を削除しない。 |
| SV-070.2 | `test_parallel_copy_delete_completes_every_real_file_and_workspace_row` と `test_parallel_browser_copy_delete_keeps_surviving_save_tokens` は2要求が同時に確定へ到達するまでHTTP境界で待ち合わせ、ネイティブ元画像とOPFS元画像の両方で全出力・全削除を確認する。 |
| WS-137.1 | `LiveHttpEndpointTests.test_concurrent_first_uploads_share_one_session_and_close_its_handle` は初回並列転送の一時領域とロックハンドルを共有し、終了時に閉じることを確認する。 |

ED-132.3 は画像一覧の右クリックメニューを閉じた後のフォーカス・選択・スクロール維持と、キーボード起動時の復帰先を実Chromiumで確認する。

履歴分岐のマスクURLは `LiveHttpEndpointTests.test_history_branch_uses_fresh_mask_urls_and_keeps_manual_revision_current` で、枠変更→元に戻す→別の枠変更→元に戻す・やり直すを実HTTPへ送り、画素とURLの対応、手描きrevisionの一致、復元失敗後の旧マスク取得と次編集を確認する。内容の復元と表示用revisionを区別し、対象外画像のrevisionは変えない。

上書き後のキャッシュは `LiveHttpEndpointTests.test_overwritten_same_stat_image_has_fresh_asset_urls_after_reopen_and_restart` で、更新時刻・ファイルサイズが同じでも変更前の画像URLを再利用しないこと、再開・再起動後の画素、サムネイル生成と一覧削除時の清掃を確認する。

WS-101.1 は `workspace/test_browser_source_reopen.py` と実Chromiumの `workspace/test_browser_source_reopen_e2e.cjs` で、未命名のファイル・フォルダー読込から命名・再開までの全画像と履歴保持、旧ソース識別子の分裂、同名で内容が異なるファイルのハンドル対応、権限不足時の復元対象、再開を繰り返してもIDB行が増えないことを確認する。元のソース行や画像IDを統合・削除しない。

DI-184.1 の復帰同期は一覧世代を変えずに確認済み・非表示・反転を変更する。現在のキャンバスと未保存の下書きを維持し、画像・候補の版だけが変わった場合は未保存中の旧版を保ち、編集がないときに画素・マスクを再取得して表示倍率と位置を保持する。画像・マスクの取得失敗では旧画像と下書きを保持し、同期が重なっても最新の一覧レコードへ旧版を戻して次回の取得を可能にする。

元画像削除は一時退避直後の進捗記録と復元記録をSQLite triggerで失敗させ、元パス・候補を保持したまま同tokenの再試行と再起動ができることを確認する。ブラウザー側は実Web LocksとIndexedDBで、実行中の削除を同タブ・別タブの復旧が取り消さず、タブを閉じた後に復旧できることを確認する。

FE-079.1 は四隅の色が異なる画像を実HTTPで取得し、上下・左右反転後のサムネイルを初回生成・キャッシュ再利用の両方で確認する。サーバーは元ファイルの向きを保持し、既存の画面試験で中央画像とサムネイルに同じ反転が一度だけ適用されることを確認する。

保存画像の生成はコピー・上書き双方で再試行も失敗させ、予約の取消しと復旧用tokenの削除を `test_browser_save_runtime.cjs` で確認する。ギャラリーの順序試験は実際に編集画面と画像一覧を切り替え、表示中のカードを照合する。

`tests/saving/test_active_save_recovery_e2e.cjs` は同じブラウザーの2タブで単一・一括保存を動かし、自タブと別タブの復旧が進行中の予約を取り消さないこと、保存同士の並列性、タブ終了後の取消し、復旧通信が遅くても新保存を妨げないことを確認する。実Web Locksを使用し、タイムアウトやheartbeatによる所有判定は追加しない。

一覧切替のキャッシュ解放失敗では `test_project_native_relink_http.py` の既存試験でDB・表示・履歴の巻戻しを照合し、境界生成との同時操作試験と合わせて確認する。モデルダウンロードの起動失敗後の再試行は、通信応答だけをfixtureへ置き換え、実際の取得・検証・保存まで通す。

`tests/saving/test_renamed_source_recovery_e2e.cjs` は実際のIndexedDBとOPFSを使い、名前変更上書きのサーバー確定直後にタブを閉じる。単一・一括保存、通常再読込・プロジェクトの元画像再読込、ブラウザーとDBで異なるsource ID、clientKeyがない旧行、親フォルダー保持を検証する。確定拒否時は新ファイルとpending行だけを戻し、IndexedDB書込み失敗時はサーバー確定しない。

ネイティブ一括上書きの確定失敗は `test_browser_save_runtime.cjs` で、拒否・未確定・結果不明・確定済みの4状態を分ける。拒否と未確定だけ予約を取消し、結果不明は復旧可能なまま残し、確定済みは成功として扱う。いずれも保存中のUI状態を解除する。

FE-084.1 の色キー透過PNG試験はRGB/Lの検出入力も確認し、透明画素を黒へ置換して候補・除外マスクを可視領域へ制限する。SD-069.1 はOSのスレッド起動失敗を注入し、ダウンロード開始前の状態へ戻り、その後の再試行が完了することを確認する。

`tests/workspace/test_boundary_catalog_concurrency.py` は境界生成のモデル準備と一覧クリア・フォルダー切替・プロジェクト削除を2スレッドで重ね、状態通知とキャッシュ解放が相互待ちにならず、元ファイルを保持することを確認する。実モデルの読込直前で停止し、GPUは使用しない。

SV-058.1 の2万画像性能試験は、一覧・編集画面を往復する各回でウィンドウサイズ変更と確認状態の再描画を行う。非表示側のカード数が0を保ち、表示側の仮想化と画像キャッシュの制限が維持されることを確認する。

`tests/verification-contracts.<domain>.json` を確認項目の唯一の参照元とします。手動チェックリストは廃止しました。各観測は次のいずれかへ分類します。

| 状態 | 意味 |
| --- | --- |
| `automated` | 同じ利用者観測を決定的に再現する。収集・実行・成功を照合するテストIDを記録する。 |
| `retired` | 自動化不能な実環境観測や検証方針から除外した観測。元IDと観測内容を保ち、個別の `retirementReason` を記録する。自動検証済みとは扱わない。 |

## 現在の内訳

| 分野 | 自動 | 手動 | 対象外 | 合計 |
| --- | ---: | ---: | ---: | ---: |
| 起動・読み込み・一覧・プロジェクト | 216 | 0 | 19 | 235 |
| 描画・境界・候補・表示・履歴 | 173 | 0 | 2 | 175 |
| 検出・モデル・設定・ショートカット | 203 | 0 | 18 | 221 |
| 保存・書き出し・異常時・リリース | 122 | 0 | 16 | 138 |
| 通信・対象の組合せ・プロジェクトデータ | 474 | 0 | 5 | 479 |
| 画像反転・保存形式・メタ情報 | 150 | 0 | 3 | 153 |
| **合計** | **1,338** | **0** | **63** | **1,401** |

件数は契約JSONの `observations[].status` から集計した値です。変更時はこの表も同じコミットで更新します。

ブラシの円外保持と候補枠プレビューの取消は `test_editor_brush_padding_e2e.cjs` で、合成画像・実ポインタードラッグ・実Worker出力・保存用PNG・Undoを画素単位で照合する。候補枠の長押しは押下中の複数回の輪郭更新、最新値の確定、失敗時の復元、操作中断時の停止を自動確認する。ブラシ径1〜300pxとShiftホイールの上下限は `test_editor_basic_tools_e2e.cjs` で表示・カーソル・値を確認する。

`test_editor_gesture_live_browser.py` は実ブラウザーのクリック・ドラッグを実HTTP、SQLite履歴、PNG保存まで通し、候補枠取消、4種の手描き、Undo・Redo、PJ再開直後の再編集とUndo、元画像不変を画素単位で照合する。

ED-114.2 の画像間の手描き・履歴保持は `editor/test_draft_transition_e2e.cjs` でも確認する。実ChromiumのPNG変換を保留して画像を往復・連続選択し、変換完了まで元画像を維持して最後の選択だけを表示する。変換失敗時は選択・画素を保ち、追加・除外・除外消去の変更領域と履歴基底を再試行へ引き継ぎ、再選択後の画素とUndo・Redoを照合する。履歴を持たないAPI応答には空の履歴を捏造せず、3層PNGをローカル履歴の基底にする。通常の無名・名前付き作業はともに永続履歴を使い、`test_editor_gesture_live_browser.py` で実HTTP・SQLiteを通した連続選択、3層の初回表示、初編集のUndo・Redo、ページ再読込後の画素保持を確認する。

WS-039.1 の一覧絞り込みメニューは `test_workspace_contract_browser.cjs` で、420×760 px の表示域でもボタン直下に開き、横にはみ出さないことを確認する。

4K画像の描画は `test_mosaic_4k_e2e.cjs` で確認する。候補と除外を重ねた状態のブラシ描画、変更領域だけの読み取り、近傍タイルだけの取消用保持、取消後の画素と状態の復元を実Chromiumで検証し、ED-106.1 に対応させる。物理CPU・RAMの継続測定である ED-106.2 は対象外のまま区別する。

`test_editor_direct_observations_e2e.cjs` の ED-093〜096・ED-114 は製品の下書き保存処理を通し、Undo・Redoと画像往復後の画素・候補状態・画像解放を確認する。ED-106 の描画中コピー数の確認も維持する。`test_editor_canvas_geometry_runtime.cjs` は製品のcatalog世代判定を読み込んで画像選択の成功・失敗を確認する。

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

同ファイルの `test_thumbnail_cleanup_failure_after_commit_keeps_batch_successful` は、保存確定後のサムネイル列挙・削除が失敗しても出力・元画像・履歴を保持し、次画像まで保存を完了することを確認する。予約・一時ファイル・保存記録の後始末も照合する。

SV-087.1 の `test_browser_commit_cleanup_failure_keeps_receipt_and_finishes_other_cleanup` は、ブラウザー保存確定後のサムネイル列挙・削除と一時画像削除が失敗しても、成功記録・出力・一覧を保持し、独立した後処理と画像キャッシュ解放を継続することを確認する。再確定の結果は変わらず、受領確認で残留一時ファイルを回収する。

WS-036.2 は `tests/workspace/test_project_catalog_lifecycle.py` の native/session 各 `catalog_remove_finishes_when_thumbnail_listing_fails` 試験で、一覧削除確定後のサムネイル列挙失敗でも原本を保持し、候補キャッシュ・取り込みコピー・保存準備ファイルを清掃することを確認する。返却一覧とDBを同期し、次の操作を続行できる。

`tests/saving/test_apply_unchanged_source.py` は、無変更の元画像上書きでは内容の再読込と一時出力をせず、元のバイト列・更新日時・履歴を保持することを確認する。開始後に元画像が変更・削除された場合は成功扱いしない。コピー、メタ情報除去、形式変更、改名、反転、マスク適用では要求どおりに保存する。

`tests/saving/test_native_save_transfer.py` は、PC上の元画像への単一・一括上書きで、使わない画像データをブラウザーへ転送せず、保存結果と元画像変更の検知を維持することを実HTTP・Chromium・PNG画素で確認する。無変更時は元画像の再読込や応答用コピーを行わない。変更時の準備ファイルは確定まで保持し、取消・再起動時の回復で清掃する。未受領の保存準備は時間経過だけでは消さない。既定の画像ストリーム、ブラウザー元画像handleへの実書込み、コピー保存先の応答も維持する。

## 資源・進捗・入力操作の回帰境界

DI-071.1・ED-114.2 は `tests/editor/test_draft_residency_e2e.cjs` で、永続保存済み30画像を連続表示した後、現在画像以外のPNGを保持せず、再選択時に同じ画素と候補の有効状態を読み戻すことを確認する。保存中・失敗したメタデータのみの変更と旧方式のローカル履歴は保持し、保存成功後に非選択画像の下書きを解放する。

ED-114.2 の保存失敗後の再操作は、同ブラウザー試験のプロジェクト新規作成ボタンで確認する。手描きON/OFFの保存が繰り返し失敗しても元の編集を保持し、通常の再操作で保存に成功してから切り替え、ページ再読込後も同じ状態を復元する。`tests/test_workspace_runtime.cjs` は、単一画像・全体の保存待ちの両方で、PNG変更を伴わない設定と下書き削除を再送し、成功後の再操作では書き込まないことを確認する。

`tests/core/test_mask_bounds_memory.py` は SD-137.1・SD-147.2・SD-061.3・ED-024.1・WS-120.1 の補助契約として、検出・境界・精液候補・手描き履歴の範囲と画素を保ち、密マスクから画素ごとの巨大な座標配列を作らないことを割当メモリ量で確認する。空・疎・非連続・細長い・符号付き入力、手の交差範囲、SAMの余白込みROI、補正失敗時の検出マスク保持、変更矩形の切り取り後の正確なUndo・Redoも照合する。実モデルの精度は対象外とする。

後段のSAM・色処理のピークが一時的な座標配列を隠すため、共通範囲計算の軸長に比例する割当量と、各経路がその実処理を呼び出すことを分けて検証する。

DI-215.1・DI-215.2 の進捗公開は `tests/jobs/test_progress_publication.py` で、512件を逆順に完了しても画像ごとに全対象を再走査しないことを入力列の訪問数で確認する。公開済みの進捗は後続完了や次のジョブ開始後も変化せず、返却JSONの変更は内部状態へ反映しない。書込みロック保持中の取得は最後の一貫した進捗を返し、検出中の処理済み件数と候補公開件数を区別する。

DI-036.2 は `tests/http/test_project_http_endpoints.py` で、日本語・空白・%・絵文字名の単体PNG出力、UTF-8のダウンロード名、同一接続の再利用、プロジェクト状態の保持を実HTTPで確認する。

ED-020.2・ED-023.1・WS-141.2 は `tests/editor/test_dialog_keyboard_e2e.cjs` で、実ポインターによる矩形作成後の名前変更ダイアログのEnter/Escape、取消ボタンのEnter、キャンバスのEnter/Escape、処理済みEnterの抑止を確認する。ダイアログ入力で背景の輪郭検出を起動せず、キャンバスでは従来の操作を維持する。

`tests/app/test_startup_catalog_and_detection_controls.cjs` の簡易DOM試験も `core.js` のダイアログ・入力対象判定を読み込み、実際の共通関数を通してイベント接続を検証する。

WS-021.1・WS-114.2・WS-116.2 は `tests/import/test_import_cancellation_e2e.cjs` で、画像追加の中断後も確定済み画像と元画像へのアクセスを保持し、未開始ファイルを送信しないことを確認する。世代・セッション交換後の旧アップロード・一覧応答は、新しいプロジェクト・一覧・元画像の参照・状態表示へ反映しない。実ChromiumとOPFSを使い、HTTP応答の順序・成功・失敗だけを境界で制御する。

旧セッションのファイル取得・アップロード失敗は件数や進捗表示を更新せず、閉じた進捗画面を再表示しないことも確認する。

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

保存先のWindowsフォルダー選択は `tests/test_native_folder_picker.py` で、透明な最前面の補助ウィンドウを作らず、所有ウィンドウなしのExplorer形式を1回呼ぶこと、フォルダー選択オプション、初期パス、取消し、結果取得の契約を確認する。製品のC#を実際にコンパイルし、COMの生成・オプション保持・初期フォルダー設定をダイアログ非表示で検証する。`tests.test_server.MozarieTests.test_output_directory_picker_normalizes_existing_absolute_hint_and_releases_lock` と `test_output_directory_picker_cancellation_and_failure_release_lock` は要求ごとのプロセス1回起動と成功・取消し・失敗後のロック解放を確認する。SD-149.2 のブラウザー試験はAPI応答を保留し、ジョブ取得・ボタン更新・重複呼出しでも要求が1回で設定欄の無効状態が続き、取消し後に再試行できることを確認する。OS所有ダイアログの点滅や前面表示は検証対象外であり、点滅の解消を自動検証済みとは扱わない。

一括保存ボタンは `tests/gallery/test_gallery_save_filters_e2e.cjs` の8画像試験で、日本語の「全画像を一括保存」と英語の「Save all images」の実表示、モザイクの有無に関係なく非表示以外の全画像を初期対象とすること、保存側の絞り込みを確認する。`tests.test_i18n_contract.TranslationContractTests.test_batch_save_label_covers_all_images_in_both_languages_and_html_fallback` は日英辞書と日本語HTML初期表示の一致を確認する。

`test_live_drag_handle_overwrites_original_without_parent_picker` は、実HTTP・Chromiumと隔離OPFS上のドラッグ元ファイルで、名前変更なし・元形式の単一／一括上書きを確認する。保存前の名前と形式、親フォルダー選択0回、Windows保存先フォルダー選択API要求0回、通常と800×600表示での保存ボタンと保存先変更ボタンの非重複、クリックとEnterキーでの保存、書込権限要求1回、元ファイルの実バイト更新を照合する。明示的な名前変更をプロジェクトに保存して再読込した場合は、変更名が残り、親フォルダー選択が1回必要になることも確認する。

`tests/test_settings_import_regressions.py` と `tests/test_import_drop_contract.cjs` は、SD-011・013・018・149、WS-012・013・137へ対応する。消えた既定保存先と新しい未作成の絶対パスを保った設定保存、相対パス・NULの拒否、初期化、実保存時の拒否、File/handle両経路、端数ミリ秒、失敗後の再取り込みを検証する。実HTTP・SQLiteとChromiumを接続した試験で、設定保存・色許容範囲・全画像検出の要求・ファイル選択・ドロップ・パス入力を操作する。推論要求だけはGPU境界で応答を代替し、設定と取り込みのHTTPは代替しない。

画像ごとの取り込み応答は一覧世代だけを読み、一覧全体は最後の要求で一度取得する。32枚のHTTP試験で全画像の識別情報・mtimeと世代を確認し、画像ごとに一覧全体を作成しないことを固定する。256枚の小PNG・逐次HTTP・通常のSQLite同期によるローカル計測では、旧処理を再現した比較が8.481秒・一覧作成257回、新処理が7.022秒・1回だった。これは当該fixtureの測定値であり、大画像や実ドライブ全般の所要を保証しない。
DI-240.1 は `tests/workspace/test_import_lookup_cost.py` で、100件・10,000件の実SQLiteソースから1件を復元する処理量を計測する。既存件数に比例した全走査をせず、画像ID・非表示・確認済み・反転状態を同じ結果として返すことを確認する。SQL文の本数だけでなく、SQLiteが実行した命令数で回帰を検出する。公開された画像追加処理でも既存一覧の並べ直し・辞書全件コピーを行わないことを、パス読取回数と一時メモリ量で確認する。同じ小文字化キーを持つ別ソースの画像は、単独追加・複数追加とも既存順序と追加順序を保持する。既存の再取込失敗試験で画像・候補・履歴・反転の巻戻しを確認する。
個別の検出設定は、保存・取消し・保存失敗・再読込後の実行値と一括設定の保持を実ブラウザーで確認します。モデル準備の表示は実HTTP・ジョブ処理とCPUのモデル境界fixtureを通し、準備、一時停止、再開、推論、追加モデル準備、完了、失敗、取消しを確認します。表示契約に実GPUや利用者の画像は必要ありません。
確認フラグの編集後保持と一覧専用削除は `test_review_list_removal_e2e.cjs` のブラウザー操作、`test_project_catalog_lifecycle.py` の元画像保持・再起動、`test_workspace.py` の旧履歴復元で確認する。WS-027・WS-029・WS-036 と DI-051〜053・DI-088〜097・DI-255 の契約を対応させ、実機確認項目は追加しない。

元画像の変更検知・同寸法の受け入れ・範囲の拡縮・クリア・PJへの移行でも、確認済み／未確認の両方を維持する。WS-027 のPython契約で再起動と全履歴のUndo/Redoまで確認する。

一般設定の検証・保存は、検出ダイアログの取消し後も保存済みの対象を使うことを確認します。
除外の強制適用の既定値は、`tests/test_settings_dialog_e2e.cjs` の `exclusion force default persists and controls untouched images` で、OFF保存・再読込後とON再保存後に、それぞれ未編集の画像へ反映されることを確認する。

設定保存・初期化では保存先の存在や書込み可否を検査しない。`test_settings_save_validates_once_without_probing_output_directory` は更新の検証が一度で、既存の原子的書込みだけが一時ファイルを作ることを確認する。`test_settings_reset_removes_override_without_probing_output_directory` は初期化時に保存先への試し書きを行わないことを確認する。実保存とフォルダー選択時の検証は維持する。

コピー保存先が消えた場合は、個別・一括の保存画面で作成確認を出す。取消しでは保存画面・入力・対象を保ち、ブラウザー権限要求・保存準備・設定書込み・作成を始めない。作成を選んだときだけ現在設定された絶対パスを作り、そのまま保存する。既存の使用可能なフォルダーは従来どおり直接保存し、ファイルや利用不能な場所は作成確認を出さず既存のエラーを表示する。新しいパスを直接入力した後にブラウザー元画像の削除を伴う場合、権限要求をユーザー操作内で始めるため、既存フォルダーなら保存の再押下を案内する。`tests/test_missing_output_directory_e2e.cjs` の個別・一括操作、長いパス表示、再表示時の状態更新、ブラウザー権限境界、`tests.test_settings_import_regressions.SettingsImportRegressionTests.test_missing_output_requires_explicit_create_and_uses_current_configured_path` と `test_unusable_output_is_not_reported_as_missing_or_overwritten` が画面・HTTP・ディスク状態を検証する。

FE-084.1 の色指定透過PNGは `tests/image_io/test_mosaic_transparency.py` で、RGB・グレースケールに実マスクを適用した出力を復号して確認する。メタ情報保持のON/OFF、透明部分を含むブラシ、平均色が元の透明色と一致する場合、再保存を含め、透明度・可視部分の平均色・非選択画素を保持する。保持ONではテキスト・背景色・有効ビット数をPNGのalpha形式に合わせて保持し、OFFでは付加情報を除く。色とalphaの扱いは [PNG仕様](https://www.w3.org/TR/png-3/#11tRNS) に従う。

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

Pillow 12.3の画素列は `get_flattened_data()` で読み取り、`tests/data_integrity/test_persistence_and_authority_transactions.py`、`tests/data_integrity/test_source_state_and_project_restart.py`、`tests/test_project_export_mask_alpha.py`、`tests/workspace/test_project_workspace_persistence.py` を警告がエラーになる条件で実行する。画素値、透過マスク、履歴、プロジェクト再読込の既存の期待値を維持し、警告の除外は追加しない。

## キーボード操作面の契約収集

ED-132.1・ED-132.2 の操作対象は、`test_ui_control_manifest.cjs` でHTML開始タグから収集する。標準のbutton・input・select・textareaに加え、0以上のtabindex、またはseparatorロールを持つ要素を含め、tabindex=-1だけのフォーカス移動先は除外する。小さいHTML fixtureでこの区別と、未登録のキャンバス・分割バーが契約不足として失敗することを確認する。

| 操作面 | 実行結果を照合する既存テスト |
| --- | --- |
| gallerySplitter・candidateSplitter：ポインターと矢印キーによる幅変更、画像・選択・候補の保持 | `test_workspace_splitters_e2e.cjs::workspace pane splitters preserve content and use gesture deltas` |
| compareSplitter：ポインターとキーによる比率変更、上下限、再読込後の保持 | `test_padding_splitter_e2e.cjs::<file>` |
| editorCanvas：実描画操作による各レイヤーの画素変化 | `test_editor_basic_tools_e2e.cjs::basic editor tools keep their pixel-layer contracts` |

4要素は既存の専用試験への対応を`ui-control-manifest.cjs`へ記録し、通常実行とCIで各test IDの収集・実行・成功を照合する。manifest本体の検証IDは `static UI controls have complete executable interaction contracts` とし、ED-132の参照も同時に更新する。

## ブラウザーcoverageの集約

`test_test_discovery.cjs` は、実際に `startJSCoverage()` を呼ぶテストとCIのproducer一覧が完全に一致することを確認する。`test_coverage_js.cjs` は専用の一時ファイルで、初回作成、複数producerの追記による先行結果の保持、不正JSON・配列でない既存結果の拒否を確認する。下書き遷移とimport pickerの両writerは同じ追記処理を使い、coverage収集の失敗時もブラウザーとサーバーを閉じる。

ED-085.1・ED-086.1 の一括履歴は、別画像の筆跡転送をHTTP境界で保留して元に戻す・やり直すを押す。実SQLiteへの保存が完了するまで履歴を変更せず、保存成功時は新しい筆跡を優先し、失敗時は下書きを残して再試行できることを確認する。再表示・ページ再読込後の画素と一括操作の確認状態も照合する。

SD-066.1〜SD-069.1 は `settings/test_model_download_polling_e2e.cjs` で、進捗要求が重複しないこと、取消・次の取得・確認画面の再表示後に届く古い成功／失敗応答が表示やボタンを戻さないことを確認する。通信と時計だけをfixtureに置き換え、取消POSTの保留中は新しい進捗要求を送らず、取消中・取消失敗のいずれも応答後の次回取得で完了状態に進む。現行要求の失敗時にはエラー表示と閉じる操作が維持されることも確認する。実モデルの取得は実行しない。

SD-009.1・SD-010.1 は元画像削除の成功、失敗、後処理待ち、失敗と後処理待ち、ブラウザー事前確認の拒否を実Chromiumで操作する。件数・対象・失敗原因を英語→日本語→英語で再表示し、削除専用の案内と診断ログの元コードを確認する。保存・名前変更向けのエラー案内は変更しない。
