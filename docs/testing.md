# テスト方針

変更は利用者が観測する契約を守るために検証する。行数や分岐の数字を目標にせず、障害になった境界、状態遷移、データの破損・喪失を優先する。`docs/test-traceability.md` と実機確認項目は、対応する自動テストと同じコミットで更新する。

## 層の選択

| 層 | 対象 | 例 |
| --- | --- | --- |
| Python契約 | 設定、入力、永続化、画像変換、ジョブ、更新処理の決定的な規則 | 相対パス拒否、一覧世代、候補履歴、保存receipt |
| ループバック統合 | HTTPのフレーミング、状態とSQLiteの接続、ストリーム応答 | 認証後の変更要求、保存応答、古いcatalog世代 |
| ブラウザーコード契約 | Nodeで再現できる画面外の純粋な分岐 | ブラウザー保存時のsource snapshot失敗 |
| 実機確認 | 表示、操作感、OS・ブラウザー・GPU・モデル・権限の実挙動 | Windowsダイアログ、実UNC、実GPU、検出モデル、描画とフォーカス |

最も小さい層で再現できる規則は自動化する。複数層にまたがる変更は、下位層で失敗境界を固定し、実機では利用者に見える残りだけを確認する。

## fixtureと後始末

- fixtureは各試験専用の一時ディレクトリ、DB、ポート、状態を使い、リポジトリ、利用者の設定、実画像を変更しない。
- 開いたファイル、SQLite接続、サーバー、スレッド、生成した一時ファイルは試験中に明示して閉じる。GCやプロセス終了に後始末を任せない。
- モックはOS、GPU、ネットワーク、時計など外部境界に限る。製品内部を写経するモックではなく、公開された入力と出力を確認する。Nodeの`node:test`では各試験の`context.mock`を使い、試験終了時に自動復元される範囲で置換する。
- 実GPU、実モデル、Windowsダイアログ、OS権限、実UNCはCI fixtureに置き換えない。該当する実機確認を残す。

## AIにテストを依頼するときの指示

AIには対象の利用者観測を一つずつ示し、初期状態、操作、成功時の不変条件、失敗時に保持する不変条件を指定する。実在のパス、画像形式、並列要求など、障害を再現する最小限で現実的なデータを使う。規則を確認できる最小の層を選び、OS、GPU、ネットワーク、時計などの外部境界だけをモックする。

固定時間の待機、`skip`、`TODO`、文字列が含まれるだけの確認は作らない。ブラウザーでは locator、応答、状態遷移を待ち、fixtureは専用の一時状態で閉じる。追加したテストは、対象の変更を意図的に壊したときに失敗することを確認し、人が差分を読んでから採用する。coverageの数字を上げる目的でテストを増やさない。

`tests/` 配下の `test_*.cjs` は再帰的に同じ順序で通常実行とcoverageへ渡す。`test_gallery_performance_e2e.cjs`だけはcoverageから外し、`test-quiet` の `frontend` と `all` がcoverage成功後に非instrumentedで1回実行する。Nodeの構造化テスト結果でSKIP/TODOが一件でも報告された実行は失敗にする。Windows専用のPython試験はWindows CIで実行するため、backendもskip 0件を要求する。

Pythonの自動テストは製品の`.venv`を参照・変更しない。リポジトリ直下に`.venv-test`を作成し、`requirements-test.txt`だけを入れて`node scripts/test-quiet.cjs`を実行する。別の隔離環境を使う場合は`MOZARIE_TEST_PYTHON`へそのPython実行ファイルを指定する。製品`.venv`配下は指定できない。

## 回帰境界

次の境界が変わるときは、成功だけでなく失敗後の状態も検証する。

- catalogの世代、PJ切替、並列読込、古い要求、再試行
- 元画像削除、保存token、receipt、再起動後の復旧、出力所有権
- 絶対パス、旧設定移行、入力フレーミング、Windowsパスの正規化
- SQLiteの原子性、履歴、候補・手描き・非表示の永続化
- 大きな画像、ストリーム出力、空き容量、メモリ不足、更新ZIP

不具合を直したら、再現した最小の公開入力を回帰試験にし、対応する手動IDを `docs/test-traceability.md` へ追加する。完全に同じ利用者観測をCIで再現できる場合だけ手動行を削除する。それ以外は自動化済み部分と実環境部分へ分けて残す。

## CIとcoverage

CIは隔離fixtureで実行できるテストを常に実行する。frontend jobはcoverageを完了してから、非instrumentedの20,000件カタログ性能試験を1回実行する。Playwrightは利用者に見える画面と隔離した`BrowserContext`を使い、固定待機ではなくlocatorや応答などのweb-first条件で待つ。coverageは全対象のレポートを毎回生成し、未検証の境界を見つける補助にする。100%などの数値を合否条件にせず、損失・破損・権限・復旧の重要経路を人が確認する。数値達成のためのテスト、内部実装を固定するテスト、skipによる見かけの成功を作らない。実行時間やメモリが増える回帰は、小さいfixtureで件数に比例しないことを確認する。

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
