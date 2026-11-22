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
   - 取込試験: 9項目すべて OK。図面タブ試験: D1〜D13・改訂 R1〜R6 すべて OK（Googleログイン・Picker・Driveは tools/stubs で差し替え）。一覧の読込試験: C1〜C7 すべて OK（Firebase SDK と Firestore REST を差し替え）。
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
