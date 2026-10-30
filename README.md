# 年表のあつまり（chronology）

歴代の総理大臣や元号、偉人の生没年などを、上から下へ時間が流れる同じ見せ方で並べた年表です。年表ごとにディレクトリを分けていて、どれも GitHub Pages で動く版を見られます。

**サイト：[ihideck.github.io/chronology](https://ihideck.github.io/chronology/)**

## 年表

<!-- 年表の一覧ここから（build.mjs が書き換えます） -->
| 分類 | 年表 | 期間 | 件数 | ディレクトリ |
|---|---|---|---:|---|
| 政治と首脳 | [歴代総理大臣と世界の首脳](https://ihideck.github.io/chronology/prime-ministers/) | 1885年〜現在 | 105 | [prime-ministers/](prime-ministers/) |
| 政治と首脳 | [歴代アメリカ合衆国大統領](https://ihideck.github.io/chronology/us-presidents/) | 1789年〜現在 | 47 | [us-presidents/](us-presidents/) |
| 政治と首脳 | [中国の最高指導者](https://ihideck.github.io/chronology/china-leaders/) | 1861年〜現在 | 29 | [china-leaders/](china-leaders/) |
| 政治と首脳 | [ロシア・ソ連の最高指導者](https://ihideck.github.io/chronology/russia-leaders/) | 1855年〜現在 | 17 | [russia-leaders/](russia-leaders/) |
| 政治と首脳 | [イギリスの君主](https://ihideck.github.io/chronology/uk-monarchs/) | 1760年〜現在 | 10 | [uk-monarchs/](uk-monarchs/) |
| 政治と首脳 | [自由民主党総裁](https://ihideck.github.io/chronology/ldp-presidents/) | 1956年〜現在 | 29 | [ldp-presidents/](ldp-presidents/) |
| 日本の歴史 | [元号と天皇](https://ihideck.github.io/chronology/eras/) | 645年〜現在 | 251 | [eras/](eras/) |
| 日本の歴史 | [歴代天皇](https://ihideck.github.io/chronology/emperors/) | 642年〜現在 | 98 | [emperors/](emperors/) |
| 日本の歴史 | [日本史と世界史の時代区分](https://ihideck.github.io/chronology/periods/) | 紀元前3000年〜現在 | 82 | [periods/](periods/) |
| 日本の歴史 | [偉人の生没年](https://ihideck.github.io/chronology/lifespans/) | 570年〜1989年 | 63 | [lifespans/](lifespans/) |
| 日本の歴史 | [戦争・大きな出来事（1868年〜）](https://ihideck.github.io/chronology/events/) | 1868年〜現在 | 70 | [events/](events/) |
| 日本の歴史 | [日本の景気循環](https://ihideck.github.io/chronology/business-cycles/) | 1951年〜現在 | 32 | [business-cycles/](business-cycles/) |
| 文化 | [お札の肖像](https://ihideck.github.io/chronology/banknotes/) | 1885年〜現在 | 48 | [banknotes/](banknotes/) |
| 文化 | [歴代横綱](https://ihideck.github.io/chronology/yokozuna/) | 1790年〜現在 | 72 | [yokozuna/](yokozuna/) |
| 文化 | [将棋の名人と竜王](https://ihideck.github.io/chronology/shogi-titles/) | 1612年〜現在 | 58 | [shogi-titles/](shogi-titles/) |
| テクノロジー | [ソフトウェアのサポート期間](https://ihideck.github.io/chronology/software-support/) | 1995年〜現在 | 75 | [software-support/](software-support/) |
<!-- 年表の一覧ここまで -->

## しくみ

| ファイル | 中身 |
|---|---|
| `<年表>/chronology.json` | 年表の名前、CSV の列の意味、出典、ページの組み方（どのデータをどの列に並べるか） |
| `<年表>/*.csv` | データ（1行に1項目）。GitHub 上でも表として読めます |
| `<年表>/index.html` | ブラウザで開く版（`build.mjs` が作る） |
| `<年表>/timeline-light.svg`・`timeline-dark.svg` | README 用の画像（`build.mjs` が作る） |
| `<年表>/README.md` | 説明と一覧表（マーカーの間を `build.mjs` が書き換える） |
| `src/timeline.mjs` | データの整形・レイアウト・SVG の描画（ビルドとブラウザで共用） |
| `src/page.html`・`src/home.html` | 年表ページとトップページの雛形 |
| `build.mjs` | すべての年表を作り直す |

ページには、ほかのディレクトリのデータも列として重ねられます。たとえば総理大臣の年表は、`us-presidents/` や `events/` のデータを読み込んで並べています。

## 更新のしかた

1. CSV を編集します。たとえば新しい総理が就任したら、`prime-ministers/prime-ministers.csv` の前の行に退任日を入れ、新しい行を足して退任日を空欄にします（空欄は在任中という意味です）。
2. `node build.mjs` を実行します（Node.js 18 以降。追加のパッケージは不要です）。データに書式の誤りや順序の乱れがあれば、ここで知らせます。
3. 各ディレクトリの `index.html`・`timeline-*.svg`・`README.md` の一覧と、トップの `index.html` が作り直されます。画像の続いている棒は実行した日（日本時間）まで伸びます。日付を指定するときは `node build.mjs --as-of=2026-10-30` のようにします。
4. コミットして `main` に push すると、数分で動く版（GitHub Pages）も新しくなります。動く版は `main` のファイルをそのまま公開しています。

## 年表の足し方

1. ディレクトリを作り、CSV を置きます。1行目は列名です。日付は `YYYY-MM-DD` で、月日が分からなければ `YYYY-MM` か `YYYY` と書きます。紀元前は負の年（紀元前221年なら `-0221`）です。1582年10月15日より前の日付はユリウス暦として扱います。
2. `chronology.json` に、名前・CSV のどの列が名前／開始日／終了日か（`data.columns`）・出典を書きます。既存のディレクトリが見本です。`page` を書かなければ、そのデータだけを1列に並べたページになります。
3. 別の年表と重ねたいときは、`page.columns` に列を足します（`data` にディレクトリ名を書く）。
4. `node build.mjs` を実行します。
