# 投資デイリー — 1日3回、株式市場をやさしく整理

株式市場の動きを朝・夕・夜の1日3回配信する静的サイト。Claudeのスケジュール実行が記事を生成し、GitHub Actionsがビルド・公開する。SNS告知(Bluesky/Threads・日英2言語・ペルソナ文体)はローカルスクリプトが行う。

- 公開URL: https://9qu1.github.io/invest-daily/
- 姉妹サイト: [AIデイリー](https://9qu1.github.io/ai-news-daily/)
- 記事生成ルール: [CLAUDE.md](CLAUDE.md)(スロット制・数値検証・売買推奨禁止)

## コマンド

```bash
npm install        # 初回のみ
npm run build      # dist/ にサイト生成
npm run serve      # http://localhost:4600 でプレビュー
```

## 構成

ai-news-daily と同一のジェネレーター構成(articles/*.md → build.js → dist/)。相違点:

- カテゴリ: news(市況・ニュース)/ guide(投資入門)/ column(コラム)
- 全記事に投資免責文を自動挿入
- 1日3スロット(morning 7:30 / close 16:30 / night 21:30)+土日は週間まとめ・来週の展望
- ユーザー側の残作業は [TODO-あなたの作業.md](TODO-あなたの作業.md) を参照
