# テスト方針

変更は利用者が観測する契約を守るために検証する。行数や分岐の数字を目標にせず、障害になった境界、状態遷移、データの破損・喪失を優先する。`docs/test-traceability.md` と契約台帳は、対応する自動テストと同じコミットで更新する。手動チェックリストは廃止し、新しい手動確認項目は追加しない。

## 層の選択

| 層 | 対象 | 例 |
| --- | --- | --- |
| Python契約 | 設定、入力、永続化、画像変換、ジョブ、更新処理の決定的な規則 | 相対パス拒否、一覧世代、候補履歴、保存receipt |
| ループバック統合 | HTTPのフレーミング、状態とSQLiteの接続、ストリーム応答 | 認証後の変更要求、保存応答、古いcatalog世代 |
| ブラウザーコード契約 | Nodeで再現できる画面外の純粋な分岐 | ブラウザー保存時のsource snapshot失敗 |
| ブラウザー統合 | 実Chromiumによる表示、操作、永続化、描画とフォーカス | ダイアログ、保存失敗の表示、IndexedDB、OPFS |

最も小さい層で再現できる規則は自動化する。複数層にまたがる変更は、下位層で失敗境界を固定し、必要な画面上の結果をブラウザー統合で確認する。物理機器・OS所有の画面・主観的な操作感など自動で同じ観測を再現できない残りは検証対象外とし、自動テストで確認済みとは扱わない。

## fixtureと後始末

- fixtureは各試験専用の一時ディレクトリ、DB、ポート、状態を使い、リポジトリ、利用者の設定、実画像を変更しない。
- 開いたファイル、SQLite接続、サーバー、スレッド、生成した一時ファイルは試験中に明示して閉じる。GCやプロセス終了に後始末を任せない。
- モックはOS、GPU、ネットワーク、時計など外部境界に限る。製品内部を写経するモックではなく、公開された入力と出力を確認する。Nodeの`node:test`では各試験の`context.mock`を使い、試験終了時に自動復元される範囲で置換する。
- 実GPU、実モデル、Windowsダイアログ、OS権限、実UNCそのものをCI fixtureで検証したとは扱わない。それらの結果を受け取るアプリの決定的な分岐を検証し、物理環境そのものの観測は個別理由付きで対象外にする。

## AIにテストを依頼するときの指示

AIには対象の利用者観測を一つずつ示し、初期状態、操作、成功時の不変条件、失敗時に保持する不変条件を指定する。実在のパス、画像形式、並列要求など、障害を再現する最小限で現実的なデータを使う。規則を確認できる最小の層を選び、OS、GPU、ネットワーク、時計などの外部境界だけをモックする。

固定時間の待機、`skip`、`TODO`、文字列が含まれるだけの確認は作らない。ブラウザーでは locator、応答、状態遷移を待ち、fixtureは専用の一時状態で閉じる。追加したテストは、対象の変更を意図的に壊したときに失敗することを確認し、人が差分を読んでから採用する。coverageの数字を上げる目的でテストを増やさない。

`tests/` 配下の `test_*.cjs` は再帰的に同じ順序で通常実行とcoverageへ渡す。`test_gallery_performance_e2e.cjs` と `test_mosaic_drag_performance_e2e.cjs` はcoverageから外し、`test-quiet` の `frontend` と `all` がcoverage成功後に非instrumentedで1回実行する。Nodeの構造化テスト結果でSKIP/TODOが一件でも報告された実行は失敗にする。Windows専用のPython試験はWindows CIで実行するため、backendもskip 0件を要求する。

Pythonの自動テストは製品の`.venv`を参照・変更しない。リポジトリ直下に`.venv-test`を作成し、`requirements-test.txt`だけを入れて`node scripts/test-quiet.cjs`を実行する。別の隔離環境を使う場合は`MOZARIE_TEST_PYTHON`へそのPython実行ファイルを指定する。製品`.venv`配下は指定できない。

## 回帰境界

次の境界が変わるときは、成功だけでなく失敗後の状態も検証する。

- catalogの世代、PJ切替、並列読込、古い要求、再試行
- 元画像削除、保存token、receipt、再起動後の復旧、出力所有権
- 絶対パス、旧設定移行、入力フレーミング、Windowsパスの正規化
- SQLiteの原子性、履歴、候補・手描き・非表示の永続化
- 大きな画像、ストリーム出力、空き容量、メモリ不足、更新ZIP

不具合を直したら、再現した最小の公開入力を回帰試験にし、`docs/test-traceability.md` へ対応を追加する。既存観測と対応する場合は元IDを保つ。自動化済み部分と検証対象外の実環境部分を混同しない。

## 確認項目の契約台帳

`tests/verification-contracts.<domain>.json` は、`264f70d` 時点の各 `docs/manual-verification/*.md` を起点として、全確認項目を `automated`、`manual`、`retired` のいずれかへ割り当てる。台帳には開始文書のパスとcommit、開始行数、観測数を記録する。開始行数は固定値を転記せず、検証時に `git show 264f70d:<path>` から物理表行数を再計算する。`ED-133・ED-134` のような複合IDセルは個別IDへ分解し、`DI-009a` のような枝番も保持する。一つの開始IDを決定的な自動観測と実環境観測へ分割してよいが、観測keyは全domainで一意にし、同じIDを異なるdomainファイルへ重複登録しない。

`automated` は同じ利用者観測を検証するテストIDを一件以上持つ。Node IDは `node:<リポジトリ相対path>::<親suite > test名>`、Python IDは `python:<完全修飾unittest ID>` とする。`node:test`へ個別testを登録していない旧式ファイルのtest名は `<file>` とする。フロントエンドは `node:test` の構造化結果からファイル、親suite、test名、pass・fail・skip・todoをmanifestへ記録する。バックエンドはshard manifestの発見ID、選択ID、実行数、skip、結果を使う。台帳が参照するテストが未収集、未実行、改名、suiteから脱落、fail、skip、todoのいずれかならテスト実行を失敗にする。テストファイルが存在するだけでは自動化の証拠にしない。

現在の台帳では `manual` は0件とし、確認文書を削除する。`retired` は元key・sourceIds・observationを保ち、`retirementReason` にその観測を対象外にした個別理由を必ず記録する。削除済み文書の基準IDと物理行数は引き続きGitの基準コミットから検証する。新しい手動行や基準IDの欠落を認めない。

`automated` への移行には、同じ利用者観測を行うテストが通常実行とCIの双方で収集・実行され、passしたことをmanifestで照合できる必要がある。自動化不能な実環境観測は検証方針の変更に従って `retired` に移し、未検証であることと個別理由を保つ。公開Releaseのタグ・ZIP・版・マージ後SHAなどはリリース実施時の公開状態検証で照合する。契約JSON、対応するテスト、確認文書の削除は同じコミットに含める。

## CIとcoverage

CIは隔離fixtureで実行できるテストを常に実行する。frontend jobはcoverageを完了してから、非instrumentedの20,000件カタログと4Kブラシ操作の性能試験を各1回実行する。ブラシ試験は入力イベントから実際のプレビュー描画までの時間をブラウザー内で測り、著しい遅延の回帰を検出する。Playwrightは利用者に見える画面と隔離した`BrowserContext`を使い、固定待機ではなくlocatorや応答などのweb-first条件で待つ。coverageは全対象のレポートを毎回生成し、未検証の境界を見つける補助にする。100%などの数値を合否条件にせず、損失・破損・権限・復旧の重要経路を人が確認する。数値達成のためのテスト、内部実装を固定するテスト、skipによる見かけの成功を作らない。実行時間やメモリが増える回帰は、小さいfixtureで件数に比例しないことを確認する。

CIのfrontend通常テストは、再帰探索したファイル一覧を辞書順に並べ、位置を二つのshardへ交互に割り当てる。各shard内はブラウザーfixtureのCPU競合を避けるため一並列のまま実行し、完全な探索一覧・選択一覧・実行結果・Node coverage・browser V8 coverageを別々のartifactへ保存する。集約jobは両shardのindex、探索一覧、期待partition、和集合、重複、pass、skip、todoを検査してからcoverageを結合し、確認項目の契約台帳を一度だけ照合する。新しいテストファイルは手動一覧を更新せず、どちらか一方へ必ず割り当てられる。

20,000件カタログと4Kブラシの性能試験は通常shardへ混ぜず、専用jobで一度だけ実行する。集約jobは両テストのmanifestと成功結果も必須にする。公開される必須checkは集約jobの `frontend` とし、shardまたは性能jobの失敗を明示して失敗する。ローカルの `npm test` は従来どおり全frontendテストを直列実行する。`test-quiet frontend` の12分上限は、その全件直列実行が停止したことを検出する監視時間であり、製品データや処理件数の上限ではない。

各suiteの子プロセスには用途別の上限時間を置き、失敗または時間切れでは経過時間と完全な標準出力・標準エラーをsuite artifactへ残す。CIはcoverageの有無にかかわらずsuite artifact全体をuploadする。ローカルでbackendの実行環境を明示する必要がある場合だけ、`MOZARIE_TEST_PYTHON`にPython実行ファイルを指定する。製品用`.venv`やGPU設定はテスト実行環境の選択に使わない。

高回数のbrowser File System Access保存量試験は、操作回数と実ファイル・実SQLの境界を保つ。OS同期だけは、その試験の専用SaveJournal接続で省略できる。SaveJournalの障害、再起動回復、耐久性の契約は通常の同期設定で別に実行する。

Windows backendは、`unittest` が発見したテストIDを辞書順で二つのshardへ交互に割り当てる。各shardは専用の一時app・bytecode・coverageを使い、停止を早めず両方の失敗artifactを残す。集計する`backend` jobは全shardのmanifestから選択集合の重複・欠損・skipを検査してcoverageを結合するため、新しいテストも手動の一覧変更なしで一度だけ実行される。shardが失敗した場合も`backend` jobを失敗にする。既存の必須checkは集計jobの`backend`を使う。

frontendの通常実行は、実ブラウザーfixtureのCPU競合を避けるため一並列にする。各ブラウザー試験は、`domcontentloaded`後に対象のAPI結果・状態・画面を待って開始する。`networkidle`や固定時間待機を準備条件に使わない。

## 参照

- [Python unittest](https://docs.python.org/3/library/unittest.html)
- [Python tempfile](https://docs.python.org/3/library/tempfile.html)
- [Node.js test runner](https://nodejs.org/api/test.html)
- [Playwright BrowserContext](https://playwright.dev/docs/browser-contexts)
- [Playwright best practices](https://playwright.dev/docs/best-practices)
- [Playwright web-first assertions](https://playwright.dev/docs/test-assertions)
- [GitHub ActionsでのPythonテスト](https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-python)
- [GitHub Copilotでテストを書く](https://docs.github.com/en/copilot/tutorials/write-tests)
- [GitHub Copilot coding agentのテスト指示](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-to-work-on-tasks/best-practices-for-using-copilot-coding-agent-to-work-on-tasks)
- [Google Testing Blog: Code Coverage Best Practices](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html)
- [FileSystemFileHandle.getFile()](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/getFile)
