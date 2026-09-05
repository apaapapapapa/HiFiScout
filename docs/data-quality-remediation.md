# 商品データ品質の調査・修正手順

この文書は、現在の実装に沿った調査手順と維持すべき契約を扱います。過去のCSV監査の件数、
完了済み作業、棄却済み仮説はGit履歴を参照してください。現在の未対応事項はIssueと新しい
監査結果で管理し、古い出品IDや集計値をそのまま本番修正の対象にしません。

## 調査の入口

| 症状 | 最初に確認する実装・証拠 |
| --- | --- |
| メーカーが解決されない | `src/catalog/manufacturer-resolver.ts`、`src/db/manufacturer-repository.ts`、raw値と検証済みエイリアス |
| 型番が分裂する／別製品がまとまる | `src/catalog/model-resolver.ts`、`src/catalog/product-identity.ts`、`src/db/product-search-exact-identity.ts` |
| カテゴリが不正／未分類が多い | `src/catalog/category-evidence.ts`、`src/catalog/category-classifier.ts`、ショップのcatalog capability |
| 同じ商品で詳細補完結果が違う | `src/crawler/category-enricher.ts`、`src/crawler/detail-enrichment-plan.ts`、保存済み詳細証拠とキャッシュ |
| 修正が次回クロールで戻る | `src/db/product-write-repository.ts`、`src/db/data-quality-remediation-service.ts`、管理override |
| 再生が進まない／検索だけ古い | resolver version、`remediation_projection_required`、D1のremediation queueとcrawl work items |
| 分類率・在庫・検索件数がおかしい | 出品単位とentity単位、snapshot日時、収集とprojectionの各watermark |

[データ品質の契約](./data-quality.md)、[検索・保存構造](./data-platform-architecture.md)、
[クロール制御](./crawl-orchestration.md)を症状に応じて参照します。

## 修正の進め方

1. **対象を再確認する。** 必要な出品のraw値、導出値、resolver version、分類証拠、override、
   identityのstatus/veto理由、entity membershipを比較します。同じtitleだけでは同じ入力とは
   限りません。sellerのメーカー欄、詳細証拠、適用エイリアス、評価時刻も確認します。
2. **原因を再現する。** 抽出・正規化・証拠の強さ・永続化・再生・検索投影のどこで差が生じるかを
   切り分けます。件数や文字列の似かよりだけで分類ルールや同定ゲートを変更しません。
3. **最小の層を修正する。** 店舗固有のHTML抽出はadapter、共通の意味判定はcatalog、保存や再生は
   repositoryで修正します。新しい実店舗アクセスをCIの回帰テストに組み込みません。
4. **既存行の収束経路を用意する。** ルール変更時は`src/catalog/resolution-versions.ts`と対応する
   再生selectorを確認します。適用済みmigrationは編集せず、必要な変更は新規migrationにします。
   単なるversion刻印で未完了のprojectionを完了扱いにしません。
5. **境界を検証する。** 正常例、同じraw入力の再実行、曖昧例、付属品・revision違い、override保持を
   既存の適切なテスト層で確認します。検証コマンドはルートの`AGENTS.md`を参照します。
6. **反映とデータ収束を分けて確認する。** マージ後のデプロイSHA、運用health、残件・失敗件数、
   `rowsRead`/`rowsWritten`を確認します。コードが反映されても既存データの再生は後続し得ます。

## 維持する契約

### カテゴリ・証拠

- 現行はtaxonomy v3です。製品種別は`SRC.*`、`PRC.*`、`CAB.*`などのcanonical leaf、
  接続方式やwireless等はfacet、内蔵DAC等はcapabilityで表現します。
- `unclassified`は内部センチネルであり、公開フィルタや手動分類の選択肢ではありません。
  旧`other`や`wired_earphone`等を新規canonical IDとして復活させず、現在のtaxonomy定義と
  互換aliasを確認します。
- メモリ上の未分類`categoryIds: []`と、永続化されるセンチネル／membershipは別の契約です。
  現行の`direct_category_ids`は構成製品のleafを保持し、祖先closureと代表カテゴリを導出します。
  複数製品のセットを常に単一leafに縮めません。
- 「中古品」「DAP・ヘッドホンアンプ」等の広いseller bucketは単一製品種別の確定証拠では
  ありません。`authoritative` / `corroborative` / `ignore`の方針を守ります。
- 詳細ページは商品固有の構造から証拠を抽出します。周辺商品、付属品説明、自由文全体の単語を
  根拠に分類を確定しません。詳細補完は商品同定単位で共有し、陰性結果のキャッシュも保持します。

### メーカー・型番・検索同定

- `manufacturer_id`は公開フィルタ互換ID、`canonical_manufacturer_id`は検証済みメーカー同定です。
  両者の不一致だけで欠陥とは判定しません。プレースホルダーはメーカーとして公開しません。
- raw seller値を維持し、決定的な型番とKnowledge Catalogのcanonical modelを区別します。
  `MK2`、`TX`、`SE`、`Meta`等のrevision/editionや付属品を示す語を除いて強制統合しません。
- modelが`candidate` / `unresolved`ならcanonical matchやexact fallback groupingに昇格させません。
  fuzzy候補は検証済み同定ではありません。色も製品名の一部か外装仕上げかを先に判定します。
- 検証済みcatalogへの`matched`は`c-<id>`、安全な完全一致の未同定グループは代表出品の`l-<id>`です。
  `unresolved_listing`というkindだけから「必ず1出品1カード」と判断しません。
- 空白や記号を除いた型番が一致しても、カテゴリ衝突や意味の異なる表記の可能性を確認します。
  件数改善のためにvetoを弱めず、回帰例を`test/`に残します。

### 永続化・負荷

- 手動修正は[出品管理](./listing-admin.md)のoverride経路で保持し、後続クロールから保護します。
- 変更された出品からprojectionを更新し、exact identityはdirty setで修復します。
  正常クロールごとの全件再生、Alarmごとのstaged inventory再読込、公開リクエストでの履歴集計を
  再導入しません。
- 詳細補完の計画・target chunk・cursorを分離し、D1に保存済みの詳細ページを再取得しません。
  negative cacheを含むmetadataだけの変更もあり、出品列の差分だけでmetadata同期を省略しません。
- Query call数、SQL statement数、返却行数、D1の課金対象行数を区別します。計測metadataがない
  結果をゼロ負荷とは扱いません。

## 運用経路と完了条件

公開Workerの`/api/admin/*`は404です。旧`ADMIN_TOKEN`付きcurlを運用手順として使いません。
catalog/listingの編集・CSV exportはAccess保護されたadmin Worker、調査と再生は維持されている
Actions/scriptsを使います。

- `Production Operational Health`：データと検索同定の検証。自動修復ループではありません。
- `Resolver Replay Drain`：D1 REST API経由で上限付き再生。
  [再生statusの意味](./resolver-replay-status.md)を確認し、未収束なら負荷と残件を見て次のbatchを判断します。
- `Product Data Audit`：必要な場合の全件監査。通常のデプロイや再生完了から自動起動しません。
- `scripts/repair-product-search-gaps.ts`：明示的な検索投影修復。書き込みに加えて残件の広い検査も
  行うため、通常の低負荷readやdocs検証として実行しません。

再生順序はraw evidenceを維持した上で、メーカー → 型番 → カテゴリ／facet／capability →
Knowledge Catalog候補と検証 → Product Identity → search entity／offers → DQ snapshotです。
詳細は[再構築とbackfillの順序](./data-quality.md#rebuild-and-backfill-order)を参照します。

完了報告には対象SHA、実行した検証、データ収束の確認範囲と残件を記載します。snapshotや公開countの
更新待ち、quotaによるデプロイ延期、未計測のCPU/課金行数は、確認済みの成功と分けて記載します。
