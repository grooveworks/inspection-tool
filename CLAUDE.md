# inspection-tool 改修手順（2026/11/21制定）

このリポジトリは `index.html` 1ファイルのアプリ。main への push で GitHub Pages
（grooveworks.github.io/inspection-tool/）に公開される。Firebase プロジェクト: inspection-tool-f7c6e。

## 絶対ルール
- 明示的に頼まれていない変更はしない。見た目が変わる変更は、コード前にプレビューを出して決めてもらう。
- 出力（push）のたびにバージョンを上げる（`const VER = "vX.Y.Z"`）。同じ番号で中身の違うファイルを出さない。
  - 機能追加・挙動変更 = Y を上げる／修正・小変更 = Z を上げる
- 途中経過を出さない。検証が全部終わってから push する。
- 【事実】と【仮説】を分けて報告する。試していないこと（例: Firebase 同期）は「未確認」と書く。

## 手順
1. **最新を取る**: `git fetch --depth=10 origin main`。改修前の `index.html` を `../baseline_vX.Y.Z.html` として保存（これが比較の基準）。
2. **ブランチを切る**: `feature/<内容>`。
3. **既存コードを解析してから書く**: 保存キー（localStorage `_projects`）、`Store` の関数、`normalizeProject`、
   取込経路（案件一覧の「JSONから取込」、寸法編集の追加インポート、NCタブ）、`save()` / `renderProject()` を確認。
4. **改修 → バージョンを上げる**。
5. **検証（必須）**:
   ```
   node tools/verify.js ../baseline_vX.Y.Z.html index.html ../verify_out
   ```
   - 画面差分: 頼まれた変更とバージョン表記以外に差分が出たら原因を調べる。差分のある画面は必ず画像を目で見る。
   - 取込試験: 9項目すべて OK。図面タブ試験: D1〜D16・改訂 R1〜R6 すべて OK（Googleログイン・Picker・Driveは tools/stubs で差し替え）。成績書の番号付き図面・印刷試験: S1〜S8 すべて OK（印刷は Chromium のPDF出力で用紙サイズを確認。python3 の pypdf を使う）。一覧の読込試験: C1〜C7・ログイン L1〜L4 すべて OK（Firebase SDK・Auth と Firestore REST を差し替え。この試験は http://127.0.0.1 で配信して行う。file:// だと localStorage が次のページに届かず不安定になる）。
   - ページエラー: none。
   - 新しい挙動を足したら、`tools/verify.js` の試験にも足す。
6. **push**: `git push -u origin feature/<内容>`（浅いクローンなので `-c push.negotiate=true` を付ける）。
7. **公開**: 指示があれば main を早送り（`git push origin HEAD:refs/heads/main`、強制 push はしない）。
   - 浅いクローンで「non-fast-forward」と出たら `git fetch --depth=10 origin <ブランチ>` で履歴を足してから再実行。
8. **公開確認**: 公開URLの `const VER` が新しい番号になるまで待ち、公開ファイルとコミットの `index.html` が完全一致することを `cmp` で確認。
9. **報告**: 何を変えたか／何を検証したか（事実）／未確認のこと。main に入れたかどうかを必ず明記。

## 一覧の読込（v2.5.0〜）
- 起動時は前回の一覧（localStorage `_listCache`）をすぐ表示し、最新が届いたら差し替える。`_projects`（端末内データ）とは別キーで、上書きしない。
- 一覧の取得は Firestore REST（1回のHTTPS GET）を先に使い、失敗したら SDK の `orderBy("updatedAt","desc").get()` に戻る。REST の結果は SDK と同じ形に変換（更新日時のない文書は除外）。
- 案件を開く・保存・同期は従来どおり SDK。

## 改訂差分（v2.6.0〜）
- 案件の `rev:{from, items[], gone[], other[]}`。items は `{g:"dims"|"features"|"dists", k:"new"|"tol"|"nom"|"mod", old, t, est, …キー}`。
  行との対応はキーで取る（dims/dists: nominal+upper+lower(+view)、features: name+view）。NCを取込み直しても印は残る。
- 表示: 測定・NC・図面タブの該当行にオレンジの「改訂：…」、各表の下に灰色の「旧版から削除」「その他の変更」。rev がない案件の見た目は変わらない。
- 取込: rev だけのJSONでも同じ図番の既存案件に付く（該当なしはエラー）。

## ログイン（v2.7.0〜、A1：書き込み・削除はログイン必須）
- 同期モードでは、端末で初回だけログイン画面を出す（Firebase Auth が端末に保持）。ログインは GIS のトークン（scope: openid email drive.readonly）を `signInWithCredential` に渡すので、図面用ログインと1回で済む。info-manager@groove-works.jp 以外は拒否してログアウト。
- Firebase 側: Authentication の Google を有効化、外部プロジェクトのクライアントID（inspection-tool-515411 のOAuthクライアント）をセーフリスト登録、承認済みドメインに grooveworks.github.io。
- Firestore ルール（projects）: 読み取りは誰でも可／作成・削除は本人のみ／更新は本人のみ、ただし `drawing` と `rev` だけの更新はログインなしでも可（Claude が REST で図面の紐づけ・改訂差分を書くため）。
- 保存が権限エラーになったら画面下に赤帯「保存できませんでした（ログインが切れています）」。

## 図面の拡大縮小（v2.8.0〜）
- 図面タブは2本指のピンチで拡大縮小（動かしている間は CSS の拡大で見せ、離したらその倍率で描き直す。指の間の場所は動かさない）。倍率は 0.3〜12。ブラウザ自体の拡大は `touch-action: pan-x pan-y` で止める。
- タブレットのブラウザはキャンバスの大きさに上限があるため、ページ全体の画像は 16M画素以内に抑える。それを超える倍率では、見えている範囲だけを高精細で描いた画像を重ねる（スクロール・拡大のたびに描き直す）。

## 成績書の番号付き図面（v2.9.0〜）
- 成績書タブで、図面が紐づき・位置（locs）のある寸法がある案件だけ、表の後に「検査箇所図」を付ける。各位置に赤枠＋引出線＋番号の丸（番号＝成績書の No.）。図面のページごとに1枚。位置のない項目は「図面に位置のない項目: No.…」と注記。
- 番号の丸は他の丸・赤枠と重ならず用紙内に収まる場所を自動で選ぶ。実測値・判定は図面に書かない（表で見る）。
- 図面PDFが未読込なら「番号付き図面を表示」ボタン（印刷されない）。その端末で Google ログイン済みなら自動で読む。
- 印刷: 成績書は A4縦、図面は A3横（`@page sheet`）。成績書タブでは印刷時に画面の高さ制限を外し（`.print-flow`）、行が多ければ2ページ目以降へ続ける（v2.9.1〜。v2.9.0以前は画面の高さで切れ、45行の成績書は22行目まで・総合判定なしの1枚だった）。

## 表示名 CAM（v2.9.2〜）
- 画面上の「NC」はすべて「CAM」（タブ・CAMデータ取込・図面タブの区分「CAM 穴・形状／CAM 距離」・メッセージ）。内部名（TAB "nc"、renderNC 等）と取込JSONのキー `nc` は互換のため変えない。

## データ形式（取込JSON）
抽出の手順と形式の正本はプロジェクトの「図面公差抽出ナレッジ.md」。アプリ側の要点だけ記す。
- 取込口は案件一覧の「JSONから取込」1か所。`{partName, drawingNo, dims[], nc{features[], dists[]}}`
- 同じ `drawingNo` の案件がある & `nc` あり → その案件の `nc` だけ置換（dims・測定値は保持、既存NCがあれば確認ダイアログ）
- 該当なし → 新規案件（dims なし・nc のみでも可。nc のみは `drawingNo` 必須）
- dims のみ → 従来通り新規案件
- `nc` は表示専用。各行の `chk`（チェック欄）は案件データに保存。取込で置換するとチェックは外れる。
- dims / nc.features / nc.dists の各行は `locs:[{p,x,y,w,h}]`（図面上の位置、ページ番号と0〜1の割合）を持てる。同じ図番の再取込では既存寸法に locs だけ反映（値・測定値は保持）。
- 図面タブ: 案件の `drawing:{fileId,name}` に Google Drive の図面PDFを紐づけ、行タップで該当位置を表示。設定値（Cloudプロジェクト inspection-tool-515411、OAuthクライアントID、APIキー、ログインアカウント info-manager@groove-works.jp）は index.html の `GCFG`。ログインは login_hint でこのアカウントを指定し、アカウント選択画面を出さない（v2.4.1〜）。APIキーは Drive/Picker のみ・リファラ https://grooveworks.github.io/* のみに制限済み（/inspection-tool/* まで絞ると Picker が「デベロッパーキーが無効」になる）。
- 図面の紐づけは取込JSONの `drawing:{fileId,name}` で行う（v2.4.0〜）。抽出時に Claude が図面PDFを Drive の「寸法検査_図面」フォルダ（ID 1kg33mlBqbkuF377u1Dn7zZie7u98mEgA）へ入れ、その fileId を JSON に書く。ユーザーに Drive 操作をさせない。
  - 同じ図番の案件がある & `drawing` あり → 図面だけ紐づけ直す（ncなしなら NC は触らない）。`drawing` だけで該当案件なし → エラー。
  - 手動の「図面を選ぶ」はフォルダ一覧を出さない（PDFのみ・一覧表示・図番の先頭2区切りで検索済み）。
