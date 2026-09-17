# 検索で見つけられるための公開確認

公式サイトは [https://norqis.github.io/mozarie/](https://norqis.github.io/mozarie/) です。GitHub Pages を有効にして `main` の Website workflow が成功したあと、公開 URL をブラウザーのシークレットウィンドウで開き、タイトル、説明、ダウンロードへのリンク、`/sitemap.xml` が表示されることを確認します。

## Search Console の登録

Search Console では URL-prefix プロパティとして、末尾のスラッシュを含む `https://norqis.github.io/mozarie/` を登録します。プロパティの所有者は、Search Console が発行した固有の HTML ファイルを `site/` に追加して公開するか、発行した固有の `google-site-verification` meta タグを `site/index.html` の `<head>` に追加して検証します。どちらも発行元のアカウントに結び付く値なので、値がない状態で仮のタグやファイルを置きません。

所有者の確認後、Search Console の Sitemaps で `https://norqis.github.io/mozarie/sitemap.xml` を送信します。URL inspection でホームページを検査し、公開済みの変更があるときだけ「インデックス登録をリクエスト」を使います。再クロールとインデックス登録には期限の保証がないため、結果は URL inspection と Search Console のレポートで確認します。

## 公開時の確認項目

- Website workflow の `Website contract`、`Build Pages artifact`、`Deploy Pages` が成功している。
- 実際の公開 URL で、canonical URL が `https://norqis.github.io/mozarie/`、サイトマップには同じ絶対 URL が一つだけある。
- GitHub Release の「最新版をダウンロード」、日本語・英語 README、Issues、リポジトリへのリンクがそれぞれ到達する。
- 幅 1440px と 390px で横スクロールがなく、最初の画面で最新版のダウンロードリンクを読める。Tab 移動時にフォーカス枠が見える。

## 参照

- [Google Search Central: SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Google Search Central: Ask Google to recrawl your website](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl)
- [Google Search Central: Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Search Console Help: Verify your site ownership](https://support.google.com/webmasters/answer/9008080)
- [GitHub Docs: Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
