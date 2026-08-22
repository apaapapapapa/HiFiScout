# HiFiScout 商品データ品質 修正指示書

**対象データ**: `hifiscout-product-audit-active-2026-08-22.csv` — 稼働中出品 8,381 件（全件 `is_active=1`）
**作成日**: 2026-08-22
**リポジトリ**: `C:\Workspaces\HiFiScout` / ブランチ `feat/catalog-csv`

---

## 0. この指示書の読み方

### 0.1 検証状況の凡例

各所見には検証レベルを付けています。**実装の前に必ず確認してください。**

| 記号 | 意味 |
| --- | --- |
| ✅ **検証済み** | 独立した検証エージェントがコードとデータを再計算し、機構を `file:line` まで特定した |
| 🔷 **自己確認** | 数値を再計算し、該当コードを直読して機構を確認した |
| ⚠️ **機構未確認** | 数値は計測済みだが、原因の特定が未完了。**推測で修正しないこと。まず機構を特定する** |

### 0.2 最重要の注意

この監査では、**当初の仮説のうち3件が検証によって棄却されました**（§7）。数値が正しくても機構の解釈が誤っていた例が多数あります。特に以下は直感に反するので注意してください。

- 店舗横断の重複は**すでにほぼ解決済み**です。8,381 出品は 7,791 検索エンティティに集約されています。
- 付属品（ダストカバー等）と本体の同定衝突は**発生していません**。既存のガードが正しく機能しています。
- `manufacturer_id` と `canonical_manufacturer_id` の不一致は**設計どおり**で、矛盾ではありません。

### 0.3 リポジトリ規約（必ず遵守）

- コミット前に `npm run verify` を**1回だけ**実行する。個別コマンドを5回叩かない。
- スキーマ変更は `migrations/` に**新規ファイル**を追加する。適用済みマイグレーションは**編集しない**。
- first-party ソースは TypeScript のみ。`.js` / `.mjs` / `.cjs` を追加しない。
- `npm run docs:generate` / `docs:build` / `docs:dev` は実行しない。

---

## 1. 現状サマリ

| 指標 | 値 |
| --- | --- |
| 稼働中出品 | 8,381 件 |
| **未分類（`classification_status='unclassified'`）** | **5,047 件（60.2%）** |
| `primary_category_id='other'` | 5,303 件（63.3%） |
| メーカー未解決（`manufacturer_resolution_status='unresolved'`） | 5,955 件（71.0%） |
| カタログ製品に同定済み（`identity_status='matched'`） | 369 件（4.4%） |
| 検索エンティティ数 | 7,791 個 |
| **1つ以上の欠陥を持つ出品** | **4,717 件（56.3%）** |

店舗別の分類率:

| 店舗 | 出品数 | 分類済み | 分類率 |
| --- | ---: | ---: | ---: |
| hifido | 4,304 | 1,816 | 42.2% |
| fujiya-avic | 2,171 | 991 | 45.6% |
| ippinkan | 770 | 68 | **8.8%** |
| audiounion | 241 | 51 | 21.2% |
| afroaudio | 240 | 152 | 63.3% |
| shimamusen | 187 | 39 | 20.9% |
| formusic | 180 | 76 | 42.2% |
| u-audio | 128 | 41 | 32.0% |
| dynamic-audio | 73 | 38 | 52.1% |
| avac | 48 | 35 | 72.9% |
| osakaya | 24 | 21 | 87.5% |
| soundpit | 15 | 6 | 40.0% |

---

## 2. 最優先（P0）— これを直さないと他の修正が定着しない

### P0-1. 詳細ページによるカテゴリ補完 ✅ **当初の所見を棄却／(A) を選択**

**訂正（2026-08-22 対応時）**: 「全店舗で完全に死んでいる」という当初の所見は**誤りです**。

`src/crawler/shops/index.ts:102` は `fujiya-avic` に対して
`detailCategoryEvidence: { extract: extractFujiyaDetailCategoryEvidence }` を**実際に登録しています**。
当初の grep はこの行を「型定義」と誤読していました。実装は `fujiya-avic.ts:92-104` にあり、
`FUJIYA_CATEGORY_POLICY.enrichment`（`maxRequestsPerCrawl: 20` / `cacheHours: 168`）も
`category-enricher.ts` から参照されています。`test/category-enricher.test.ts` は
`result.detailRequests === 1` をアサートしており、(A) の完了条件はすでに満たされています。

補完は fujiya-avic では**本番で動作しています**。この事実は §4 の E-2 にも波及します
（「詳細ページ由来ではありえません」という記述は成り立ちません。P0-2 を参照）。

**方針**: **(A) 実装する**を選択。理由は、機構がすでに存在し稼働しており、削除すると未分類
5,047 件の唯一の自動回収経路を失うためです。抽出は `metaDescriptions()` →
`productLeadText()` の順で**構造化された先頭要素に限定**され、本文全体は渡していません
（doc が警告した strength=`"strong"` の暴発は起きていません）。

**残作業（P0 外に切り出し）**: `hifido` の `detailCategoryEvidence` は未実装のままです。
実装には hifido の**商品詳細ページの実 HTML**が必要ですが、リポジトリにフィクスチャがなく、
アダプタが知っているのは一覧ページの構造だけです。マークアップを推測して抽出器を書くと、
本指示書自身が警告する「構造化されていない箇所からの strong 証拠」を作り込むことになるため、
実 HTML を採取するまで着手しません。なお hifido の未分類はそもそも E-3（`CATEGORY_RE` の
ブロック内自由文検索）と N-1（レコード部門 1,771 件）の寄与が大きく、補完の期待値は
fujiya-avic ほど高くありません。

---

### P0-2. 分類・メーカー解決が非決定的 ✅ **機構特定済み／カテゴリ側は修正済み**

**対象**: 機構の特定が先。候補は `src/db/data-quality-remediation-service.ts` と `src/db/product-write-repository.ts`

**現状（数値は自己計測）**:
同一店舗・**同一タイトル・同一 `raw_category`**（＝分類器への入力が同一）の出品が、異なる結果を得ています。

| グルーピング条件 | 不一致するフィールド | グループ数 | 出品数 |
| --- | --- | ---: | ---: |
| (shop, title, raw_category) | `primary_category_id` | 13 | 40 |
| (shop, title, raw_category) | `manufacturer_id` | 59 | 207 |
| (shop, title) | `primary_category_id` | 165 | 655 |
| (shop, title) | `classification_status` | 181 | 730 |
| (shop, title) | `category_ids` | 285 | 1,131 |
| (shop, title) | `manufacturer_id` | 125 | 471 |

具体例（すべて `raw_category=""`、同一タイトル）:

- fujiya-avic `Campfire Audio キャンプファイヤーオーディオ Ponderosa [CAM-5966]` ×7 → `wired_earphone` 5件 / `other` 2件
- fujiya-avic `Unique Melody ユニークメロディ UM Stardust [UNM-1895]` ×4 → `wired_earphone` 3件 / `other` 1件（**全件 `first_seen_at=2026-08-11` の同日取得**）
- fujiya-avic `MAGNETAR マグネター UDP900 [MGT-UDP900]` ×4 → `cable_other` 3件 / `other` 1件

同日取得のものが分裂しているため、分類器のバージョン変遷だけでは説明できません。

**有力仮説（要検証）**: ✅ 検証済みの P0-3 が示すとおり、`products.category_ids` には**2つの書き込み経路が競合**しています。

1. クロールパス: `catalogFields()` (`src/db/product-write-repository.ts:99-146`)
2. データ品質リメディエーション再生: `src/db/data-quality-remediation-service.ts:280`

リメディエーション再生は tick ごとに件数上限があるため（`src/db/data-quality-remediation-queue-repository.ts:392-439`）、任意の時点では一部の行だけが再処理済みになります。同一商品の行が「再生済み」「未再生」に分かれれば、観測された分裂と整合します。

加えて `enrichProductCategories()` は冒頭で `applyKnowledgeCatalogEvidence(db, products, now)` を呼ぶため（`category-enricher.ts:177`）、**時間とともに変化する DB 状態**に分類結果が依存します。

**変更内容**:

1. **まず機構を特定する。** 上記2経路それぞれについて、同一入力に対する出力を記録する再現テストを書く。仮説が外れている可能性を前提にすること。
2. 機構が確定してから修正する。**推測でルール表や分類器を書き換えないこと。**
3. 修正後、決定性を固定する回帰テストを追加する — 同一 `(shop_key, title, raw_category)` を持つ行が常に同一の `primary_category_id` / `manufacturer_id` を持つことをアサートする。

**完了条件**: 上記表のすべての行で不一致グループ数が 0 になること。次のクエリで検証できる:

```sql
SELECT shop_key, title, raw_category, COUNT(DISTINCT primary_category_id) AS c
FROM products WHERE is_active = 1
GROUP BY shop_key, title, raw_category HAVING c > 1;
```

#### 対応（2026-08-22）— 特定された機構

**カテゴリ側の機構は「詳細補完の予算が出品単位で消費されていたこと」です。** 仮説にあった
リメディエーション再生の競合ではありません。

`enrichProductCategories()` は未分類出品を**クロール順に1件ずつ**走査し、
`detailRequests >= policy.enrichment.maxRequestsPerCrawl` になった時点で以降を素通しにして
いました。fujiya-avic の予算は 20 件/クロールで、同店の未分類は約 1,180 件あるため、予算は
毎回途中で尽きます。同一商品が別 `source_id` で複数出品されていると、**予算の境界をまたいだ
グループだけが分裂**します。境界より前の複製は詳細ページから終端カテゴリを得て `classified`
になり、後ろの複製は未分類のまま残ります。

これは P0-1 の訂正と整合します。補完が動いているのは fujiya-avic だけで、本節の分裂例も
**すべて fujiya-avic** です。E-2 の `cable_other` 過剰マッチ（`MAGNETAR UDP900` ×4 が
`cable_other` 3件 / `other` 1件）も同じ機構で、「詳細ページ由来ではありえません」という
§4 の記述は成り立ちません。

再現テスト: `test/category-enrichment-determinism.test.ts`。同一商品3件・予算1件で走らせると
修正前は `['btw_earphone', 'other', 'other']` を返し、監査が観測した分裂形状をそのまま再現します。

**修正**: 補完の判断単位を「出品」から「商品同定（`manufacturerId` + `model` + `title`、
`sameIdentity()` と同じ三つ組）」に変更しました（`src/crawler/category-enricher.ts`）。

1. 未分類出品を同定キーでグループ化し、**1グループにつき詳細リクエストは最大1回**。
   予算は出品数ではなく商品数を数えるようになり、グループ内での分裂が構造的に起きません。
2. 取得した詳細証拠は各出品の**自前の seller 証拠と合成**します。seller カテゴリが実際に
   異なる複製は、これまでどおり異なる結果になれます。
3. グループ内のいずれかの複製が過去クロールで詳細分類をキャッシュ済みなら、**同定単位で
   全複製に適用**します。これが既存の分裂行を次回クロールで収束させる経路です。
4. 「詳細を見たが決まらなかった」も同定単位でキャッシュし、`cacheHours` を複製ごとに
   払い直さないようにしました。

回帰テストは、複製グループが常に単一の結果を持つこと、および**入力順を反転しても結果が
変わらないこと**をアサートします。

**メーカー側について**: `manufacturer_id` の分裂は別機構です。解決器自体は与えられた
エイリアス証拠に対して純粋関数で、非決定性は `listManufacturerAliasEvidence(db)` が返す
**D1 上の運用エイリアスが時間とともに増える**ことに由来します。書き込み時刻が違う行は違う
語彙で解決され、収束はレート制限されたリメディエーション再生に委ねられています（設計どおり
の最終収束であって、書き込み経路の競合ではありません）。なお本節の集計は
`raw_manufacturer` でグルーピングしていないため、(shop, title, raw_category) が同じでも
seller のメーカー欄が異なる行を含んでおり、59 グループ / 207 件は上振れしています。恒久対応は
N-3 の担当範囲です。

---

### P0-3. 未分類行に2種類の DB 表現がある ✅ 検証済み

**対象**: `src/db/data-quality-remediation-service.ts:280`

**現状**: 未分類 5,047 件のうち、**3,053 件が `category_ids=[]`、1,994 件が `category_ids=["other"]`**。両者は同じ状態を表しています。

**重要な訂正**: 当初は「店舗ごとに書き込み経路が違う」と推定しましたが、**誤りです**。すべての主要店舗が両方の形式を出力しています（hifido 2,186/302、fujiya-avic 699/481、audiounion 145/45、ippinkan 23/679）。日付でも分かれません。

**正しい機構**:

- `["other"]` が**正**。クロールパスの `catalogFields()` は `const categoryIds = [primaryCategoryId];` (`product-write-repository.ts:102`) と再計算しており、分類器が返す空配列は意図的に破棄されます。この挙動は **`test/unclassified-persistence.test.ts:41-101` で固定されています**（99行目で `update.binds.includes('["other"]')` をアサート）。
- `[]` が**異常値**。`data-quality-remediation-service.ts:280` の `const categoryIdsJson = JSON.stringify(classification.categoryIds);` が `catalogFields()` を迂回し、分類器の戻り値（未分類時は `[]`、`src/catalog/category-classifier.ts:46`）をそのまま永続化しています。

2つの書き込み経路が同じ行を交互に上書きするため、店舗にも日付にも相関しません。

**変更内容**: `src/db/data-quality-remediation-service.ts:280` を `catalogFields()` と同じ導出に揃える。`classification.categoryIds` が空なら `[classification.primaryCategoryId]` にフォールバックする。

**やってはいけないこと**:
- `src/catalog/category-classifier.ts:46` の `unresolved()` が返す `categoryIds: []` を `["other"]` に変えないこと。この空配列はメモリ上の契約であり、`src/crawler/category-enricher.ts:92`（`if (!categoryIds.length) return null;`）と `src/catalog/knowledge-verification/page-verification.ts:291` が「未分類」判定に使っています。
- クロールパスを `[]` 側に合わせないこと。`test/unclassified-persistence.test.ts` が壊れ、それが防いでいたバグが再発します。

**副次的な同種違反**（別チケット可）: 分類済み 19 行が2要素のクロージャを保持しています（例 `["pre_amp","amplifier"]`、`["master_clock","digital"]`）。書き込み元は `src/db/knowledge-catalog-repository.ts:336` と `src/db/knowledge-catalog-admin-repository.ts:245`。`migrations/0013_category_feature_model.sql` が宣言する「カテゴリは単一リーフ」不変条件に反します。

**完了条件**: `SELECT COUNT(*) FROM products WHERE classification_status='unclassified' AND category_ids='[]'` が 0。

#### 対応（2026-08-22）✅

- `src/db/data-quality-remediation-service.ts` の `categoryIdsJson` を `catalogFields()` と同じ
  導出に揃えました（空配列なら `[primaryCategoryId]`）。分類器の `categoryIds: []` はメモリ上の
  契約のまま**変更していません**。
- 既存行は `migrations/0040_normalize_unclassified_category_ids.sql` が修復します
  （`classification_status='unclassified'` かつ `category_ids` が空/NULL/`[]` の行のみ）。
  `category_ids` は検索読み取りモデルに射影されないため、投影の再構築は不要です。
- `test/unclassified-persistence.test.ts` に再生パス側のテストを追加しました。クロールパスの
  既存テストと並んで、両方の書き込み経路が同じ形を書くことを固定します。

---

### P0-4. 「未分類」がユーザーには「その他」として見えている ✅ 検証済み

**対象**: `src/catalog/category-classifier.ts:45`、`src/db/product-search-entity-mapper.ts:151`

**現状**: `unresolved()` が `primaryCategoryId: "other"` をハードコードしています（`category-classifier.ts:45`）。この `other` は**実在する意図的なリーフカテゴリ**で（`src/catalog/categories.ts:707-724`、`classifiable:true`、`filterable:true`、tuner / equalizer / チャンネルデバイダー等のエイリアス付き）、「答えが出せなかった」というセンチネルと**同じ ID を共有**しています。

さらに深刻なのは、**「未分類」という文字列は API に到達しません**。`src/db/product-search-entity-mapper.ts:151` が

```
category: getCategory(row.primary_category_id)?.name ?? ""
```

と ID からラベルを再導出するため、保存されている `未分類` は検索層で破棄され、すべて `その他` として出力されます。

エンティティ単位の影響: 7,791 検索エンティティのうち **5,025 個が `primary_category_id="other"`**（うち 4,750 が未分類のみ、233 が分類済みのみ、42 が混在）。ユーザーが「その他」で絞り込むとこの 5,025 件すべてが返り、レスポンスに両者を区別するフィールドはありません（`classification_status` は `src/db/product-search-repository.ts`、`src/db/product-search-entity-sql.ts`、`src/api/`、`src/http/`、`frontend/` のいずれにも出現しません）。

**変更内容**:

1. `src/catalog/categories.ts` に未分類専用のセンチネル（例 `unclassified`、`filterable:false`）を追加する。
2. `src/catalog/category-classifier.ts:45` の `unresolved()` をそのセンチネルに切り替える。
3. `src/db/product-search-entity-mapper.ts:151` でセンチネルを `未分類` に対応付ける（そうしないと修正がユーザーに見えない）。
4. `src/db/product-search-entity-sql.ts:53-54, 104-105` で新 ID を検索エンティティ表に射影する。
5. `src/db/product-search-repository.ts:203-210` と `categoryFilterIds()`（`src/catalog/categories.ts:842-857`）が「その他」フィルタをセンチネルまで展開しないようにする。
6. `src/catalog/resolution-versions.ts` の分類器バージョンを bump し、`migrations/` に**新規**バックフィルを追加する。

**バックフィル時の落とし穴**:
- 条件は `classification_status='unclassified'` にすること。`category_ids='[]'` で絞ると 1,994 件を取りこぼします（P0-3 参照）。
- 未分類 5,047 件のうち 14 件は、所属する検索エンティティの `primary_category_id` が `other` **ではありません**（`wired_headphone` 9件、`headphone_amp` 5件）。出品単位とエンティティ単位の件数は一致しません。`5047 == エンティティ数` をアサートしないこと。
- `src/catalog/categories.ts:891-897` の `normalizeCategory()` は3つめの書き込み経路で、`primaryCategoryId:"other"` + `categoryIds:["other"]` + `displayName:"その他"` を書きつつ `classificationStatus:"unclassified"` にします。P0-3 の 1,994 件の発生源はおそらくここです。

**やってはいけないこと**: `other` リーフを削除・転用しないこと。256 件の「その他」のうち 184 件は本物の雑多カテゴリ（チューナー、イコライザー、チャンネルデバイダー等）です。修正は**未分類側に専用 ID を与える**ことであり、`other` には手を触れません。

#### 対応（2026-08-22）✅

センチネル `unclassified`（表示名「未分類」、`classifiable:false` / `filterable:false`）を追加し、
`other` リーフには一切手を触れていません。

| 指示 | 実装 |
| --- | --- |
| 1. センチネル追加 | `src/catalog/categories.ts` の `UNCLASSIFIED_CATEGORY_ID`、型は `UnclassifiedCategoryId`（`src/catalog/types.ts`） |
| 2. `unresolved()` の切り替え | `src/catalog/category-classifier.ts`。あわせて `normalizeCategory()` と `catalogFields()` のフォールバックも `other` からセンチネルへ（3つ目の書き込み経路） |
| 3. `未分類` の表示 | 追加不要でした。`product-search-entity-mapper.ts` は ID から名前を再導出するので、定義があるだけで「未分類」を返します |
| 4. 検索エンティティへの射影 | fallback エンティティは `p.primary_category_id` をそのまま写すため自動。カタログエンティティの `COALESCE(..., 'other')` はセンチネルに変更 |
| 5. 「その他」フィルタの非拡張 | `unclassified` は `parentId: null` かつ `classifiable:false` なので `categoryClosureIds()` が空を返し、`categoryFilterIds("other")` に含まれません。`test/unclassified-category-sentinel.test.ts` で固定 |
| 6. バージョン bump とバックフィル | `CLASSIFICATION_METADATA_VERSION` 12 → 13、`migrations/0041_separate_unclassified_category_sentinel.sql` |

**落とし穴への対応**:

- バックフィルの条件は `classification_status='unclassified'` です（`category_ids='[]'` では 1,994 件を取りこぼす）。テストが `category_ids = '[]'` を含まないことをアサートしています。
- 検索エンティティは**代表出品経由**でのみ移します（`fallback_listing_id IN (...)`）。0036 の完全一致グルーピングにより、分類済みの代表を持つエンティティに未分類の出品が同居しうるため、出品数とエンティティ数は一致しません。
- バージョン bump により全出品が `classify_category` 再生の対象になります（`STALE_SELECTORS` の `category_version`）。マイグレーションはその高速路であり、取りこぼしはキューが収束させます。

**波及した既存挙動（意図的に保存）**:

- `src/db/product-search-exact-identity.ts` の `categoryCompatible()` は「カテゴリ未特定」を衝突とみなさない判定です。センチネル分離前は `other` 一つがその役割を兼ねていたため、`NOT IN ('other', 'unclassified')` に広げてグルーピング結果を現状どおりに保っています。
- 出品管理画面のカテゴリ選択は、センチネルを**保存可能な選択肢として出しません**（API 側も `categoryIdForClassification()` で拒否済み）。未分類の出品は「未選択」で開き、実在するリーフを選ぶまで保存できません。

---

## 3. カテゴリ分類漏れ

### G-1. 汎用スピーカーが分類されない（うち 48〜54 件は誤った終端ラベル） ✅ 検証済み

**対象**: `src/catalog/category-rules.ts:111`

**現状**: `raw_category` がちょうど `"スピーカー"` の出品は 309 件（hifido 286 / dynamic-audio 21 / soundpit 2）。結果は `other` 298 / `cable_other` 8 / `center_speaker` 2 / `subwoofer` 1。

スピーカー系カテゴリ全体でデータセット中 **39 件しかありません**（`center_speaker` 12、`subwoofer` 16、`speaker_bookshelf` 5、`speaker_floorstanding` 4、`active_speaker` 2）。中古ハイファイ市場としては実装上ありえない少なさです。タイトルまたは `raw_category` にスピーカー語を含む 587 件のうち、スピーカー系に着地したのは 20 件のみ。

**重要な区別 — 309 件のうち 280 件は「バグではない」**:

`classification_status` で分けると未分類 280 / 分類済み 29。未分類 280 件については、`sellerCategoryEvidence()` が `raw_inference` 由来の証拠を `corroborative` に降格し（`src/catalog/category-evidence.ts:94-100`）、corroborative は意図的に非分類（`category-classifier.ts:115-117` にコメント）であるため、正しく「未分類」に落ちています。**この経路は変更不要です。**

**本当のバグは 48〜54 件のタイトル経路**:

`categoryEvidenceFromText()` はタイトルの strength を既定で `"strong"` にします（`category-evidence.ts:57`）。したがってタイトルに「スピーカー」を含む出品は `category-rules.ts:111` の

```
["other", /\bsound\s*bars?\b|サウンドバー|\bspeakers?\b|スピーカー/i],
```

にヒットし、**strong tier で確定分類**され `その他` という終端ラベルが付きます。さらに `enrichProductCategories()` は分類済み商品をスキップするため（`src/crawler/category-enricher.ts:194-196, 224-227`）、このラベルは**恒久的**になります。未分類より悪い状態です。

該当例: `2Wayスピーカー`、`JBL 2115Aスピーカー`、`PCスピーカー`、`NS-C210`（ヤマハのセンタースピーカー）、`LS50 Meta`（KEF のブックシェルフ）。

なお `git show 1fabe4a`（feat: expand speaker and AV amplifier categories, #189）によれば、この行は元々 `["speaker_other", /\bspeakers?\b|スピーカー/i]` であり、`speaker_other` リーフ削除時に機械的に `"other"` へ書き換えられたものです。設計判断ではなく**リファクタの巻き添え**で、`vacuum_tube` ルール（`category-rules.ts:87-89`）のような根拠コメントもありません。

**変更内容（1行）**: `src/catalog/category-rules.ts:111` からスピーカーの選択肢を削除し、サウンドバーだけ残す。

```
["other", /\bsound\s*bars?\b|サウンドバー/i],
```

これで汎用スピーカー語は明示 ID を生まず、`classifyCategoryEvidence()` が `unresolved("unclassified")` に落ちて `未分類` になります。終端ラベルで凍結されていた 48〜54 件に対して補完経路が再び開きます。ケーブル系ルール（`category-rules.ts:27` 以降）が先に勝つため、「スピーカーケーブル」は引き続き `cable_other` に解決されます。

**やってはいけないこと**: 汎用の分類可能スピーカーリーフを追加しない／`speaker_other` を復活させないこと。`categories.ts:342` の `speaker` は `classifiable:false` が**設計上の意図**です。追加すると現在未分類の約 500 件が一斉に終端ラベル化し、`category-enricher.ts:224` の補完経路が恒久的に切れます。「その他スピーカー」という値は買い手にとってフィルタとして何の役にも立ちません。

**別途検討（本件にバンドルしないこと）**: `speaker` は既に `filterable:true` の親として存在するため、恒久的な改善は「広いが確実な証拠を `categoryIds` の祖先側に入れてフィルタ可能にし、`primary_category_id` は未分類のまま残す」ことです。ただし分類器の `categoryIds` 契約、検索リポジトリ、ファセットコードに波及するため別チケットにしてください。

#### 対応（2026-08-22）✅

指示どおり `category-rules.ts` の当該行をサウンドバーのみに縮小しました。汎用スピーカー語は
明示 ID を生まず、`unresolved("unclassified")` に落ちます。`speaker` は `classifiable:false` の
まま、`speaker_other` の復活もしていません。

`test/category-classification-gaps.test.ts` が、変更で守るべき境界を固定します — サウンドバー、
スピーカーケーブル（ケーブル規則が先に勝つ）、および `speaker_bookshelf` /
`speaker_floorstanding` / `center_speaker` / `subwoofer` / `active_speaker` の各具体リーフ。

**小さな訂正**: 該当例に挙がっている `NS-C210` と `LS50 Meta` は、タイトルに「スピーカー」を
含まないため**元々この規則にヒットしていません**（`inferExplicitCategoryIds` は無マッチ）。
凍結されていたのは `2Wayスピーカー` / `JBL 2115Aスピーカー` / `PCスピーカー` のように語を
含むものだけです。前2者は本変更後も未分類のままで、回収は補完経路／ナレッジカタログ側の
担当です。

**関連**: `LEGACY_ALIASES` の `speaker_other: "other"`（`categories.ts:740`）により、ショップ側マッピングの素のスピーカーも「その他」に着地します。256 件の「その他」のうち 44 件はスピーカー系の `raw_category`（`スピーカー` 18、`スピーカー・ヘッドフォン` 18、`中古スピーカー`、`speaker`、`speaker-system` 等）で、本物の雑多ではありません。

---

### G-2. DAP がほぼ分類されない 🔷 自己確認 / ⚠️ 一部機構未確認

**対象**: `src/crawler/shops/fujiya-avic.ts:113-125`、`src/catalog/category-rules.ts`

**現状**: データセット全体で `dap` は **13 件のみ**。一方、DAP ブランド／キーワードをタイトルに含む出品は 405 件あり、内訳は `other` 300 / `wired_earphone` 62 / `cable_other` 16 / `dap` 13 / `wired_headphone` 7 / `dac` 6。

fujiya-avic の seller bucket `"DAP・ヘッドホンアンプ"`（243 件）の結果は `other` 221 / `dap` 11 / `dac` 9 / `pre_amp` 1 / `wired_headphone` 1。

**機構（コード直読で確認）**: `FUJIYA_CATEGORY_POLICY`（`fujiya-avic.ts:113-125`）が明示的に

```
categories: Object.freeze({
  dap: "corroborative" as const,
  headphone_amp: "corroborative" as const,
}),
```

としています。`corroborative` は非分類 tier なので、この bucket は分類に寄与しません。**これは妥当な設計判断です** — `"DAP・ヘッドホンアンプ"` は2カテゴリの複合バケットであり、素直に信用すると約半数を誤分類します。

**明確な誤り（ブランドが earphone/cable も扱う点を差し引いても曖昧さがないもの）**: Cayin N6iii / N7 / N8ii、HiBy R6 III / R3 II / R5Gen2、FiiO M23、Astell&Kern KANN ULTRA、LUXURY&PRECISION E7。これらが `other` および `cable_other` に落ちています。

**変更内容**: 複合バケットを昇格させ**ない**。代わりにタイトル側で判別する。

1. `src/catalog/category-rules.ts` の `dap` ルール（現状 `/\bdap\b|digital\s+audio\s+player|デジタルオーディオ(?:プレーヤー|プレイヤー)|ポータブルオーディオ(?:プレーヤー|プレイヤー)/i`）に、既知の DAP 型番ファミリを追加する。候補: Astell&Kern `KANN`/`SP\d`/`SE\d`/`PA\d`、Cayin `N\d`、FiiO `M\d{1,2}`、HiBy `R\d`、Shanling `M\d`、iBasso `DX\d`。
2. **型番パターンは誤爆しやすい**。`M23` のような短い型番は他ブランドと衝突するため、必ずメーカー文脈（`raw_manufacturer` / `manufacturer_id`）と組み合わせること。
3. ルール表の位置に注意 — `dap` ルールは現在 `cable_other`（8番目）より後ろにあるため、`cable_other` の過剰マッチ（§4 の E-2）を先に解決しないと効きません。

**未確認事項**: 405 件のうち `wired_earphone` 62 件が誤りかどうかは未検証です。これらのブランドはイヤホンも販売しているため、**一括変換は禁止**。型番単位で判定してください。

**完了条件**: 上記の明確な誤り群が `dap` に分類され、かつ既存の `wired_earphone` 分類が退行しないこと（回帰テストを `test/` に追加）。

#### 対応（2026-08-22）✅

複合バケットは昇格させず、タイトル側に**ブランド固定の型番ファミリ**を追加しました
（`DAP_MODEL_FAMILIES` / `src/catalog/category-rules.ts`）。挙げられた明確な誤り 11 件は
すべて `dap` に分類されます（Cayin N6iii / N7 / N8ii、HiBy R6 III / R3 II / R5Gen2、FiiO M23、
Astell&Kern KANN ULTRA、LUXURY&PRECISION E7、Shanling M6 Ultra、iBasso DX320）。

**メーカー文脈の取り方（指示 2 への対応）**: `manufacturer_id` ではなく**タイトル中のブランド語**
に固定しました。FiiO / Cayin / HiBy / Astell&Kern / Shanling / LUXURY&PRECISION は
`MANUFACTURER_SOURCE` に**未登録**（N-2 の対象）で、`normalizeCatalogProduct` の時点では
`manufacturerId` が空になります。解決済み ID に依存する規則は N-2 が終わるまで 1 件も分類
しません。ブランド語は `(?:brand)[^]{0,32}?(?:model)` の形で型番と同じ文字列内に要求します。

各ブランドは**プレーヤーであることが曖昧でないファミリのみ**を列挙しています。FiiO の
`K`/`Q`/`BTR`/`FH`、Cayin の `C9`/`RU`、HiBy の `FC`、Shanling の `UA`/`ME`、Astell&Kern の `PA`
は意図的に除外しました（`PA10` はポータブルヘッドホンアンプであり DAP ではありません）。

**指示になかった誤爆クラスを1つ潰しました**: 型番はその機種の**アクセサリ名にも現れます**。
`Astell&Kern SP2000用 レザーケース` / `FiiO M23 保護フィルム` などは実装当初すべて `dap` に
なりました。ケース／カバー／フィルム／ストラップを検出する否定先読み（`DAP_ACCESSORY_GUARD`）
で塞いでいます。ブロックされた場合は誤ラベルではなく未分類に落ちます。

**指示 3 の訂正**: 「`cable_other` の過剰マッチを先に解決しないと効きません」は成り立ちません。
挙げられた DAP タイトルは**どの先行規則にもヒットしません**（実測で全件が無マッチでした）。
ケーブル語を含むタイトルは引き続き `cable_other` に解決されますが、それは正しい答えです。
なお E-2 の `cable_other` 過剰マッチ自体は、P0-2 で特定したとおり規則表ではなく詳細補完由来です。

**未確認事項について**: `wired_earphone` 62 件の一括変換は行っていません。型番ファミリに
該当するものだけが `dap` に移り、`FiiO FH19 イヤホン` のように製品種別語を持つタイトルは
これまでどおり `wired_earphone` のままです（回帰テストで固定）。

---

### G-3. 粗すぎる seller bucket は写像不能 — 601 件はルール／LLM が必要 ⚠️ 機構未確認

**現状**: `raw_category` を持つのに未分類の出品は 1,176 件。内訳:

**機械的に単一カテゴリへ写像できるもの（575 件）**:

| 件数 | raw_category | 写像先 |
| ---: | --- | --- |
| 280 | スピーカー | G-1 で対応 |
| 221 | DAP・ヘッドホンアンプ | G-2 で対応 |
| 22 | speaker-system | G-1 で対応 |
| 18 | アナログパーツ・フォノイコライザー | `phono_eq` 系（要タイトル判定） |
| 4 | cdsacd-players | `cd_sacd_player` |
| 4 | ブックシェルフスピーカー(ペア) | `speaker_bookshelf` |
| 3 | アナログプレーヤー | `turntable` |
| 2 | 管球式フォノイコライザー | `phono_eq` |
| 2 | ステレオパワーアンプ | `power_amp` |
| 2 | フロア型スピーカー(ペア) | `speaker_floorstanding` |
| 2 | スピーカーケーブル | `cable_other` |
| その他 | 各1件 × 15種 | 個別対応 |

**粗すぎて信用できないもの（601 件）— 現状の非分類は正しい**:

| 件数 | raw_category |
| ---: | --- |
| 146 | アンプ・スピーカー・プレーヤー |
| 129 | 中古品 |
| 64 | その他オーディオ機器 |
| 37 | accessories |
| 34 | 中古アクセサリー |
| 28 | ラック・その他 |
| 27 | アウトレット |

**変更内容**: 後者を bucket マッピングで解決しようとしないこと。これらは**すでに正しく非分類**です。解決経路はタイトル側のルール強化（G-1/G-2/E-1）か、P0-1 の補完経路の復活か、LLM による判定です。

#### 対応（2026-08-22）✅

粗すぎる 601 件へのマッピングは**追加していません**。指示が禁止だけなので、代わりに
その禁止を不変条件として固定しました — `test/category-classification-gaps.test.ts` が 7 バケット
すべてについて `classification_status='unclassified'` を維持することをアサートし、同時に
タイトルが製品種別語を持つ場合はバケットに勝つことも確認します。

**「機械的に写像できる 575 件」表の訂正**: 実測したところ、小口の行の大半は**マッピング不足では
ありません**。

| raw_category | 実際の状態 |
| --- | --- |
| `cdsacd-players` (4) | `FORMUSIC_CATEGORY_MAPPING` に**既に存在**（`normalizeLookup` がハイフンを除去するため `cd-sacd-players` と同一キー）。`FORMUSIC_CATEGORY_POLICY` が `cd_sacd_player: "corroborative"` を**意図的に**指定しているため非分類。FOR MUSIC はプレーヤーとトランスポートを同一バケットに入れるため、これは設計どおりです |
| `speaker-system` (22) | `speaker` グループに写像される。`classifiable:false` なので分類されない — G-1 の方針そのもので、写像漏れではありません |
| `ブックシェルフスピーカー(ペア)` (4) / `フロア型スピーカー(ペア)` (2) / `管球式フォノイコライザー` (2) / `ステレオパワーアンプ` (2) / `アナログパーツ・フォノイコライザー` (18) | 規則表は**既に正しい具体リーフを推論しています**。止めているのは `sellerCategoryEvidence()` が `raw_inference` を corroborative に降格する仕様であって、マッピングの有無ではありません。ショップ側マッピングを足しても動きません |
| `スピーカーケーブル` (2) | `cable_other` に解決されるが、同 ID が `BROAD_SELLER_CATEGORY_IDS` にあるため corroborative |
| `アナログプレーヤー` (3) | **唯一の本物の語彙欠落**。対応済み（下記） |

`アナログプレーヤー` / `アナログプレイヤー` を `turntable` の**タクソノミ別名**と規則表の両方に
追加しました。別名にしたのが要点で、`global_alias` 経由なら seller 証拠が authoritative として
扱われます（規則表だけでは `raw_inference` にしかならず、降格されて分類されません）。

降格仕様そのものの見直し（具体的な推論リーフを authoritative に昇格させる）は、G-1 の
「別途検討」と同じ理由で**本件には含めていません**。証拠 tier の変更は分類器全体に波及します。

---

## 4. カテゴリ分類誤り

### E-1. ワイヤレス機器が「有線」に分類される 🔷 自己確認

**対象**: `src/catalog/category-rules.ts`（`btw_earphone` / `btw_headphone` ルール）

**現状**:

| 種別 | タイトル該当 | `wired_*` に誤分類 | `other` | データセット全体の正解カテゴリ件数 |
| --- | ---: | ---: | ---: | ---: |
| 完全ワイヤレスイヤホン | 41 | **26**（`wired_earphone`） | 15 | `btw_earphone` = **1 件** |
| Bluetooth ヘッドホン | 60 | **17**（`wired_headphone`） | 39 | `btw_headphone` = **2 件** |

誤分類例: `SONY WF-1000XM5/BC`、`SONY WF-1000XM6 BZ`、`BOSE QuietComfort Ultra Earbuds`、`JBL TOUR PRO 3`、`Shokz OpenFit2+`、`Shokz OpenDots ONE`、`SONY WH-1000XM6 BM`、`BOSE QuietComfort Ultra Headphones`、`Bowers & Wilkins Px7 S3`、`SENNHEISER MOMENTUM 4 Wireless`。

**機構（コード直読で確認）**: ルール表の順序は `btw_earphone` → `btw_headphone` → `wired_earphone` → `wired_headphone` で**正しい**。問題はパターン側です。

```
["btw_earphone", /(?:bluetooth|wireless|true\s+wireless|\btws\b).*?(?:earphones?|earbuds?|\biem\b)|.../i],
```

`bluetooth` / `wireless` / `ワイヤレス` といったトークンが `earphone` / `イヤホン` と**共起することを要求**します。`SONY WF-1000XM5/BC` のような型番のみのタイトルにはそのトークンが存在しないため、後段の緩い

```
["wired_earphone", /\bearphones?\b|\bearbuds?\b|\biem\b|イヤホン/i],
```

に落ちます。**`\bearbuds?\b` が有線側のルールに入っているのは明確な誤り**です — earbuds は完全ワイヤレスの強いシグナルです。

**変更内容**:

1. `\bearbuds?\b` を `wired_earphone` ルールから削除し、`btw_earphone` 側へ単独シグナルとして移す。
2. `btw_earphone` に型番ファミリを追加: Sony `WF-\d`、`TOUR PRO`、`OpenFit`/`OpenDots`/`OpenRun`、`AirPods(?!\s*Max)`、`LinkBuds`、`FreeBuds`、`QuietComfort.*Earbuds`。
3. `btw_headphone` に追加: Sony `WH-\d{4}`、`WI-\d`、`QuietComfort\s+(Ultra\s+)?Headphones`、`Px[78]`、`MOMENTUM\s+\d+\s+Wireless`、`AirPods\s+Max`。
4. `AirPods Max` は**ヘッドホン**、`AirPods` 単体は**イヤホン**。否定先読みの順序を誤らないこと。

**完了条件**: 上記の誤分類例がすべて `btw_earphone` / `btw_headphone` に落ちること。`test/category-taxonomy-v2.test.ts` に固定テストを追加する。

---

### E-2. `cable_other` ルールが過剰にマッチ ⚠️ **機構未確認 — 調査が先**

**対象**: `src/catalog/category-rules.ts:34`

**現状**: ルール表8番目に

```
["cable_other", /\bcables?\b|ケーブル/i],
```

があり、ほぼすべての機器カテゴリより**先**に評価されます（ルール表は先勝ちで、`inferExplicitCategoryIds()` は最初のマッチで即 return）。

`cable_other` に分類された 306 件のうち、**53 件はタイトルにケーブル語を一切含みません**:

- DAP: HiByMusic `R6 III` / `R3 II` / `R5Gen2` / `R6 pro II`、Cayin `N7`、FIIO `M23 Stainless Steel`
- ユニバーサルディスクプレーヤー: MAGNETAR `UDP900`
- プロジェクター: Victor `DLA-V50-B`
- サウンドバー: SONY `HT-A5000`
- 真空管アンプ: Cayin `MT-35MK2 PLUS BT BK`

**未解決の問い（実装前に必ず答えを出すこと）**: これらのタイトルには「ケーブル」がありません。では**マッチしたテキストはどこから来たのか**。

- 詳細ページ由来では**ありえません** — P0-1 のとおり補完は動いていません。
- `raw_category` も大半が空です。
- 残る候補は parser hint（`policy.parserHint`、既定 `corroborative`）か、正規化前のタイトル、あるいは P0-2 の非決定性そのもの。実際 `MAGNETAR UDP900` ×4 は `cable_other` 3件 / `other` 1件に分裂しており、**E-2 と P0-2 は同一原因の可能性があります**。

**変更内容**:

1. **まず調査する。** 該当 53 件について、`products.metadata.categoryClassification.evidence`（`summarizeCategoryEvidence()` が保存、`src/catalog/product-normalizer.ts`）を D1 から引き、`source` と `value` を確認する。これで証拠テキストの出所が確定します。
2. 出所が判明してから、ルールの順序変更か証拠源の修正かを決める。**ルール表の順序を先に触らないこと** — ケーブル語を含む本物のケーブル 253 件が退行します。

**調査クエリ**:

```sql
SELECT id, title, json_extract(metadata, '$.categoryClassification.evidence')
FROM products
WHERE is_active = 1 AND primary_category_id = 'cable_other'
  AND title NOT LIKE '%ケーブル%' AND lower(title) NOT LIKE '%cable%'
LIMIT 60;
```

---

### E-3. hifido のカテゴリ抽出がブロック内自由文検索になっている 🔷 自己確認

**対象**: `src/crawler/shops/hifido.ts:21`、`src/crawler/shops/hifido.ts:137-138`

**現状**: `CATEGORY_RE` は約 30 個のカテゴリ語の選択肢を並べた巨大な正規表現で、`parseProductBlock()` が

```
const categoryRaw = text.match(CATEGORY_RE)?.[1] || "";
```

と、**平坦化したブロックテキスト全体から最初に見つかったカテゴリ語**を拾います。「ジャンル:」「カテゴリ:」といったラベルへの**アンカーがありません**。

結果、LP ボックスセット 68 件が `raw_category="カートリッジ"` を得て `cartridge` に分類されています:

- `ロック5枚セット` → カートリッジ
- `タンゴ5枚セット` → カートリッジ
- `電子音楽5枚セット` → カートリッジ
- `日本民謡５枚セット` → カートリッジ

hifido の `raw_category` → カテゴリ写像は他は健全です（`カートリッジ` 304→`cartridge` 304、`真空管` 152→`vacuum_tube` 152、`レコードプレーヤー` 110→`turntable` 110）。問題は写像ではなく**抽出**です。

**変更内容**: `CATEGORY_RE` を hifido の実際のラベルにアンカーする（`メーカー:` の抽出が `text.match(/メーカー\s*[:：]\s*(.+?)(?=\s+(?:定価|売価)\s*[:：])/i)` としてラベル基準になっているのと同じ方式）。あるいはカテゴリセルの DOM 位置に限定して抽出する。

**注意**: `HIFIDO_CATEGORY_MAPPING`（`hifido.ts:26-`）には無効なカテゴリ ID が含まれます。`スピーカー: "speaker"` は `classifiable:false` の親（G-1 参照）。`headphone` / `earphone` / `accessory` / `cable` は `CLASSIFICATION_ALIASES` / `LEGACY_ALIASES`（`categories.ts:736-751`）で救済されていますが、`speaker` だけ救済がありません。

**完了条件**: `SELECT COUNT(*) FROM products WHERE shop_key='hifido' AND raw_category='カートリッジ' AND title LIKE '%枚セット%'` が 0（N-1 で hifido のレコード部門ごと除外する場合は自動的に解消）。

---

### E-4. seller bucket の盲信 ⚠️ 機構未確認

**現状**: 35 個の `raw_category` 値が複数カテゴリに写像されます。一部は**正当なタイトル精緻化**ですが、一部は盲信です。

| 件数 | raw_category | 写像結果 |
| ---: | --- | --- |
| 340 | アクセサリー | `other_accessory` 331 / `clean_power` 4 / `cable_other` 3 / `integrated_amp` 1 / `other` 1 |
| 243 | DAP・ヘッドホンアンプ | `other` 221 / `dap` 11 / `dac` 9 / `pre_amp` 1 / `wired_headphone` 1 |
| 149 | 中古品 | **12 種類**のカテゴリに分散 |
| 75 | ラック | `rack` 66 / `integrated_amp` 4 / `cd_sacd_player` 2 / `transport` 1 / `pre_amp` 1 / `power_amp` 1 |
| 40 | アンプ | `power_amp` 14 / `integrated_amp` 10 / `pre_amp` 10 / `other` 5 / `av_amp` 1 |

`ラック` の盲信例（hifido、いずれも `raw_category="ラック"` だけで `rack` になっている）:
- `JPC-100/1.0m`（電源ケーブル）
- `JPX-2000/1.0m`（電源ケーブル）
- `LXV-OT6`（真空管アンプキット）

**変更内容**: `アンプ` → `power_amp`/`integrated_amp`/`pre_amp` のような分散は**正しい挙動**（タイトルで精緻化されている）なので触らないこと。`ラック` のようにタイトル証拠がない場合に bucket だけで確定する経路を、E-2 の調査結果と合わせて見直す。

---

## 5. 商品名・型番の表記ゆれと製品同定

### N-1. 音楽ソフト（中古レコード／CD）がハードウェアカタログに混入 ✅ 検証済み

**対象**: `src/crawler/shops/hifido.ts:122-167`

**現状**: **1,771 件（全体の 21.1%）** が `枚セット` / `枚組` のレコード・CD セット商品です。うち 1,770 件が hifido — **hifido の稼働中在庫 4,304 件の 41.1%**。すべて 1 つの店舗コード（URL セグメント `26-20368`）由来。価格帯は 2,500〜15,000 円（中央値 2,500 円）。

これらのタイトルは日本語のみのため、`normalizeIdentityModel()` の記号除去で**数量の数字だけが残ります**:

| `normalized_model` | 件数 | 例 |
| --- | ---: | --- |
| `5` | 1,153 | `アマデウス弦楽四重奏団5枚セット` |
| `6` | 83 | `ダニエル・バレンボイム（指揮&ピアノ）６枚セット` |
| `10` | 53 | `古賀政男大全集10枚組` |
| `7` | 24 | `カール・ベーム指揮／ハイドン「四季」７枚セット` |
| `105` | 19 | `長唄（舞踊用・１０インチ）5枚セット` |
| `MONO5` | 18 | `ジノ・フランチェスカッティ（MONO）5枚セット` |

**重要な訂正 — 同定の崩壊は起きていません**: 当初「1,153 件が単一の同定グループに融合している」と推定しましたが**誤りです**。この 1,153 件は 1,153 個の異なる `search_entity_key` を持ち、全件 `identity_status='unresolved'` / `search_entity_offer_count=1` です。2つのガードが正しく機能しています:

- `resolvePreparedModel()`（`src/catalog/model-resolver.ts:284-300`）が和文残渣を検出し `status:"candidate"` / `method:"unsafe_annotation"` に降格
- `resolveProductIdentity()`（`src/catalog/product-identity.ts:319-334`）が `resolved` 以外を `rejectedBy:["unresolved_model"]` で拒否

**もう一つの訂正**: 「`normalized_model` の長さ ≤ 3 は欠陥」も**誤り**です。1,799 件のうち 282 件は正当な型番（QUAD `405`、EMT `929`、B&W `800`/`805`、`2A3`、Cayin `N7`、McIntosh `C32`、`M17`）で、うち 16 件はカタログ製品に正しくマッチしています。短さ自体は欠陥シグナルではありません。ボックスセット由来は 1,395 件です。

**残る実害**:
1. 退化した `normalized_model` が `product_search_entities` に永続化され（`src/db/product-search-entity-sql.ts:111`）、LIKE フィルタと完全一致リレバンス tier（`src/db/product-search-repository.ts:137, 157-161`）で使われる。
2. そもそも HiFiScout のスコープ外。

**変更内容（優先度高 — これ1つで 1,771 件 = 21.1% が消える）**:

`src/crawler/shops/afroaudio.ts:25-30` はスコープ規則を明示し実装しています:

> Afro Audio also sells cameras, musical instruments, software and recording/PA equipment; those are intentionally excluded

hifido には同等のフィルタがありません。`listingUrl`（`hifido.ts:164-167`）はサイト全体をページングします。

1. `src/crawler/shops/hifido.ts` にレコード部門の除外を追加する。判定は `source_url` のセグメント `26-20368`、またはタイトルの `/[0-9０-９]+\s*枚(セット|組)/`。`afroaudio.ts:25-30` と同じ形式のコメントで意図を明記すること。
2. 既存行の非活性化は `migrations/` に**新規**マイグレーションを追加して行う。

**副次的（別チケット可）**: `normalizeIdentityModel()`（`src/catalog/product-identity.ts:94-99`）の 98 行目 `.replace(/[^A-Z0-9]+/gu, "")` は、全 CJK のモデル文字列を偶発的な ASCII 数字だけに縮退させます。`resolvePreparedModel()`（`model-resolver.ts:264-303`）の 282 行目のガードは空文字のみを見ているため、「主に CJK の原文から数量数字だけが生き残った」ケースも `unresolvedResult`（`normalizedModel: ""`）として拒否するよう拡張すべきです。

**完了条件**: `SELECT COUNT(*) FROM products WHERE is_active=1 AND title LIKE '%枚セット%'` が 0。未分類率が 60.2% → 約 51.3% に低下すること。

---

### N-2. メーカー解決のブランド網羅不足 — **最大のレバー** ✅ 検証済み

**対象**: `src/catalog/manufacturers.ts:9-`（`MANUFACTURER_SOURCE`）

**現状**: `MANUFACTURER_SOURCE` は約 45 エントリしかなく、`bootstrapManufacturers()` → `bootstrapAliases()`（`src/catalog/manufacturer-resolver.ts:32-44`）がここから解決を行います。**480 個の異なるフォールバック ID が解決待ち**です。

未収録の主要ブランド: **AIRBOW**（164 件）、**Astell&Kern**（107 件）、**FIIO**（77 件）、**Cayin**（70 件）、**HiByMusic**（57 件）、**Campfire Audio**（49 件）、**Unique Melody**（47 件）、**audioquest**（62 件）、**TIGLON**（46 件）、**KENWOOD**、**TRIO**。

**なぜ最大のレバーか**: `resolveProductIdentity()` は `canonical_manufacturer_id` が空だと `src/catalog/product-identity.ts:299` で短絡します。未同定 8,012 件のうち **5,955 件（全出品の 71%）がカタログ照合に到達すらしていません**。カタログ同定率 4.4% の主因は照合アルゴリズムではなく、この入口です。

**重要な訂正 — `manufacturer_id` と `canonical_manufacturer_id` は矛盾していません**: 両者は設計上**厳密に入れ子**です。

- `manufacturer_id` = 公開フィルタ用の従来スラッグ（migration 0005）。任意のメーカー文字列から `manufacturerIdForFilter()` で生成。
- `canonical_manufacturer_id` = 検証済みエイリアスに一致したときのみ設定（migration 0023）。

証拠: 解決済み 2,426 行が使う `manufacturer_id` は 50 種、未解決だが ID を持つ 1,549 行が使うのは 480 種で、**重複はゼロ**。解決済み 2,426 行では `manufacturer_id === canonical_manufacturer_id`。

**変更内容**: `MANUFACTURER_SOURCE`（`manufacturers.ts:9-`）に上記ブランドを追加する。あるいは `knowledge_catalog_manufacturer_aliases` に verified 行として投入する。

**やってはいけないこと**: `manufacturer_id` を空にしないこと。これは**稼働中の公開フィルタ ID** です（`migrations/0023_manufacturer_resolution.sql:41-42` に意図が明記）。

---

### N-3. `manufacturer_id` の非決定的な書き込み — 拡大中 ✅ 検証済み

**対象**: `src/db/product-write-repository.ts:156`、`src/db/manufacturer-repository.ts:382`

**現状**:
- **1,549 行**が `manufacturer_resolution_status="unresolved"` / `method="none"` でありながら非空の `manufacturer_id` を持つ。すべて `fallbackId(normalizeManufacturerKey(raw_manufacturer))` と一致し、`manufacturer_id != canonical_manufacturer_id` の行と完全一致。
- **2,272 行**はメーカー文字列を持つのに `manufacturer_id` が**空**（fujiya-avic 1,160 / hifido 1,016 / audiounion 75 / ippinkan 21）。
- 同一のブランド文字列が、どちらの書き手が最後に触ったかだけで異なる `manufacturer_id` を得ます。例: `Astell&Kern` 107 行のうち、`manufacturer_id="astellkern"` の 16 行は全て `last_changed_at=2026-08-22T01:31:05.077Z`（単一バックフィルバッチ）、残り 91 行は空。
- **拡大中**: 1,549 行すべてが 2026-08-21（178 件）と 2026-08-22（1,371 件）に最終更新。減衰する旧債ではありません。

**機構**:
1. **主因**: `existingCatalogFields()`（`product-write-repository.ts:156`）の
   `manufacturerId: existing.manufacturer_id || manufacturerIdForFilter(existing.manufacturer)`
   が、リゾルバが未解決とした行に対して表示名からスラッグを合成しつつ、status は `unresolved` のまま残します。
2. **自己修復を阻害**: `reprocessManufacturerRows()`（`manufacturer-repository.ts:382`）の
   `resolution.canonicalManufacturerId || row.manufacturer_id`
   がリゾルバの空文字を無視して古いスラッグを温存し、その上で `manufacturer_resolver_version = 5` を刻印するため、`selectStaleManufacturerListings()`（同 285-308）が二度と拾いません。

**変更内容**: 両箇所を権威ある生成元 `src/catalog/product-normalizer.ts:108` に揃える（未解決なら `""` を書く）。加えて「`manufacturer_resolution_status !== "resolved"` のとき `manufacturer_id === canonical_manufacturer_id`」という不変条件チェックとバックフィルを追加する。

**重要な訂正 — ブランドの捏造は起きていません**: 当初 hifido の `10号メタルリール` 36 件が `sony` / `scotch` / `technics` に分裂しているのを「隣接商品からのブランド捏造」と推定しましたが**誤りです**。この 36 件は 10 種類の異なる出品者提供ブランドを持ちます（Scotch×21、SONY×4、TEAC×3、TDK×2、AKAI、AMPEX、OTARI、Technics、HITACHI、不明）。**空の 10 号メタルリールは実際にブランド品として売られています。** `sony` / `technics` はそれぞれの行の `メーカー:` 欄の正しい解決結果（`method="bootstrap_alias"`）です。また `brand-unjvhk` はランダムではなく、正規化キー `不明フメイ` の FNV-1a ハッシュです（`manufacturers.ts:148`）。

グルーピングキーに `raw_manufacturer` を加えると、59 グループ / 207 件のうち 7 グループは正当なブランド差異として消え、**52 グループ / 164 件**が真に不整合として残ります。

---

### N-4. プレースホルダーのブランドが公開フィルタに出ている ✅ 検証済み

**対象**: `src/catalog/product-normalizer.ts:94-101`、`src/catalog/manufacturers.ts:146`

**現状**: 意味を持たない出品者メーカー値に対するストップリストがありません。**85 件の稼働中出品**が 5 種類のプレースホルダー文字列を持ちます: `不明 フメイ` 54、`その他` 20、`不明` 9、`メーカー不明` 1、`不明 ナガオカ` 1。

さらに、生成自体が非決定的です — 同じ文字列が行によって ID を得たり得なかったりします（`不明 フメイ`: `brand-unjvhk` 13 行 vs 空 41 行、`その他`: 6 行 vs 14 行）。

**実際のユーザー影響は ID ではありません**。`src/http/meta.ts:107-123` がメーカーファセットを

```sql
SELECT manufacturer_id, MIN(manufacturer) ... WHERE manufacturer <> '' GROUP BY manufacturer_id
```

で生成し、`normalizeManufacturerFacetValues` は未知の名前をそのまま通すため、**`不明 フメイ` と `その他` が公開のメーカー絞り込み選択肢として配信されています**（ID が生成されたかどうかに関わらず）。

**変更内容**:
1. `normalizeCatalogProduct()`（`src/catalog/product-normalizer.ts:94-101`）にプレースホルダー拒否セットを追加し、`manufacturer` と `manufacturerId` の両方を空にする。対象: `不明` / `メーカー不明` / `その他` / `ノーブランド`、および hifido の読み仮名付き形式 `不明 フメイ`。
2. 防御的に `fallbackId()`（`src/catalog/manufacturers.ts:146`）側でも生成を拒否する。

**前例**: カテゴリ軸では既に同じことをしています — `src/crawler/shops/audiounion.ts:187, 199, 213` が `item.category === "その他"` を落としています。

**併せて（小規模）**:
- `y-039-acoustic`（1 件）は afroaudio アダプタのメーカー抽出で HTML エンティティ `Y&#039;Acoustic` が未デコードのまま漏れたもの。
- `audioaudiotechnica`（1 件、shimamusen `【展示処分品】 audioaudio-technica AT-ART1000`）はトークン重複のパーサ不具合。

**やってはいけないこと**: `manufacturer_id` のハイフン有無を統一しないこと（§7 で棄却）。

---

### N-5. 店舗横断の重複は概ね解決済み — 残るのは 23 グループ ✅ 検証済み（当初の主張を訂正）

**重要な訂正**: 当初「8,012 件が `unresolved_listing` なので各々が個別の検索結果になる」と主張しましたが、**これは誤りです。**

2段目のグルーピング層（`src/db/product-search-exact-identity.ts`）が、`canonical_manufacturer_id` + `normalized_model` を共有する未同定出品を統合します。実測（再確認済み）:

| 指標 | 値 |
| --- | ---: |
| 出品数 | 8,381 |
| **検索エンティティ数** | **7,791** |
| 2件以上を束ねるエンティティ | 313 個（903 件） |
| **複数店舗にまたがるエンティティ** | **55 個（157 件）** |

例: `SONY HAP-Z1ES` は fujiya-avic 4 件 + audiounion 2 件 + hifido 1 件が**すべて `l-1546` に統合済み**（`offer_count=7`、`shop_count=3`）。タイトルは `SONY ソニー HAP-Z1ES` / `SONY HAP-Z1ES` / `HAP-Z1ES` と3通りに揺れていますが、正しく名寄せされています。

**実際に残る問題**: 店舗横断 49 グループ（全員未同定）のうち **26 グループは既に単一エンティティに統合済み**で、**23 グループ（56 件）だけが分裂**しています。分裂の原因は**すべて**「メンバーの誰かが `model_resolution_status='candidate'`」であり、カテゴリ衝突による veto は **0 件**です。

ゲート: `src/db/product-search-exact-identity.ts:34` の `model_resolution_status = 'resolved'`。

典型例: `mark-levinson::NO5302` — `l-5277` が3店舗を束ねる一方、shimamusen の 1 件だけが `l-5420` に取り残されています。原因は `raw_model` が `No5302 パワーアンプ` で、末尾の和文製品種別語により `candidate` 降格したこと。

**変更内容**: ゲート（`product-search-exact-identity.ts:34`）を緩めないこと。代わりに `src/catalog/model-resolver.ts` の `ANNOTATION_RULES` に、**末尾の和文製品種別語**（`パワーアンプ` / `プリアンプ` / `プリメインアンプ` / `ターンテーブル` / `サブウーファー` 等）を除去する注釈ルールを追加する。

**やってはいけないこと**: 和文残渣による `candidate` 降格そのものを弱めないこと。`src/catalog/product-identity.ts:315-318` のコメントが理由を明記しています（`D-1000 MK2 特別仕様` が正規化後 `D1000MK2` になりベース製品と完全一致してしまうのを防ぐ）。**製品種別語だけを対象**にし、`特別仕様` / `復刻` のようなバリアント語は残すこと。

---

### N-6. 真の型番衝突（1 件、要注意） ✅ 検証済み

SONY の `SLH-7-550-BL` と `SLH-7-550B-L` が**両方 `resolved`** で、`normalizeIdentityModel()` の記号除去により両方 `SLH7550BL` に正規化されます。異なる製品が誤って統合されるリスクのある唯一の実例です（22 件が同一 `normalized_model`）。

`src/catalog/product-identity.ts:98` の記号除去を見直す際の回帰ケースとして使ってください。

---

## 6. やってはいけないこと（意図的挙動の一覧）

修正担当者が壊しやすい順に並べています。**すべてコードのコメントまたはテストで意図が明示されています。**

1. **`unresolved()` の `categoryIds: []` を `["other"]` にしない**
   `src/catalog/category-classifier.ts:46`。この空配列はメモリ上の契約で、`src/crawler/category-enricher.ts:92` と `src/catalog/knowledge-verification/page-verification.ts:291` が「未分類」判定に使用。

2. **クロールパスの `["other"]` 書き込みを `[]` にしない**
   `test/unclassified-persistence.test.ts:41-101`（99行目で `update.binds.includes('["other"]')` をアサート）が固定。

3. **付属品接尾辞（`ダストカバー` 等）を model から剥がさない**
   `test/knowledge-catalog.test.ts:64-68` が `// An accessory is not a variant of the component it names.` というコメント付きで `variants("yamaha", "GT-2000ダストカバー") === ["GT-2000ダストカバー"]` を固定。剥がすと `resolved` に昇格して本体と `normalized_model` が一致し、**現在は起きていない混同を新規に発生させます**（§7 参照）。

4. **和文残渣による `candidate` 降格を弱めない**
   `src/catalog/product-identity.ts:315-318` に理由が明記。弱めると特別仕様版・復刻版が本体に吸収されます。N-5 では**製品種別語のみ**を対象にすること。

5. **`other` リーフを削除・転用しない**
   `src/catalog/categories.ts:707-724` の意図的な実カテゴリ（tuner / equalizer / チャンネルデバイダーのエイリアス付き）。256 件中 184 件は本物の雑多です。

6. **汎用の分類可能スピーカーリーフを追加しない／`speaker_other` を復活させない**
   `categories.ts:346` の `classifiable:false` は設計上の意図。追加すると約 500 件が終端ラベル化し補完経路が切れます。

7. **`真空管プリメインアンプ` → `integrated_amp` は正しい**
   `src/catalog/category-rules.ts:87-89` にコメントで明記（製品種別としてのアンプ証拠が真空管フォールバックより先に勝つべき）。誤分類として「修正」しないこと。

8. **`manufacturer_id` を空にしない**
   稼働中の公開フィルタ ID。`migrations/0023_manufacturer_resolution.sql:41-42`。

9. **`manufacturer_id` のハイフン有無を統一しない**
   §7 で棄却。ハイフン付き 18 件は人手作成の curated スラッグ、無し 484 件は `normalizeManufacturerKey()` が区切り文字を除去した後の自動生成（`manufacturers.ts:96`）。ハイフンの有無を見ているコードは存在せず、レガシー ID 互換セットも既にあります（`manufacturers.ts:180-194`、`test/manufacturer-filter-replay.test.ts:14`）。

10. **`other` がカテゴリ衝突を veto しない設計を厳格化しない**
    `src/db/product-search-exact-identity.ts:45-48` のコメントが「`other` は矛盾する証拠ではなく specificity の欠如を表す」と明記。厳格化すると多数の正当な重複統合が外れます。

11. **分類器のセンチネル ID 変更は in-place 編集不可**
    `src/catalog/resolution-versions.ts` のバージョン bump と `migrations/` への新規バックフィルが必須（`category-classifier.ts:115-118` のコメント参照）。

12. **`src/db/product-search-exact-identity.ts:34` の `model_resolution_status='resolved'` ゲートを緩めない**
    N-5 の修正は model resolver 側で行うこと。

---

## 7. 棄却された所見（修正しないこと）

検証の結果、以下は**欠陥ではない**と確定しました。当初の監査仮説に含まれていたため、明示的に取り消します。

### 7.1 付属品と本体の製品同定衝突 — **棄却**

「`KP-1100` と `KP-1100ダストカバー` が同一の product identity を共有している」という主張は**成立しません**。

- 付属品接尾辞を持つ出品は **100%（23/23）が `model_resolution_status='candidate'` / `method='unsafe_annotation'`** で、同定マッチ（`product-identity.ts:319-334`）とグルーピング（`product-search-exact-identity.ts:34`）の**両方から除外**されています。
- **本体と同一 `search_entity_key` を共有する付属品は 0 件**。全例（KENWOOD KP-1100 / KP-880D/2、Pioneer PL-50L2、DENON DP-57L / DP-51F、YAMAHA GT-2000、McIntosh C22）で別エンティティであることを個別確認済み。
- グルーピング適格集合 1,730 件 / 1,250 グループのうち、specific-vs-specific のカテゴリ衝突を持つのは **2 グループのみ**（`audio-technica|HDC114A12`、`yamaha|C2`）。どちらも付属品由来ではありません。
- 当初「約 20 グループ」としたカテゴリ衝突の**真の主因は P0-2 の非決定性**です（`AT-PEQ20` ×2 が `phono_eq` と `other_accessory`、`L-504` ×2 が `integrated_amp` と `rack` 等、5 グループ）。

**この方向に修正すると害になります**: `ANNOTATION_RULES` に `ダストカバー` を追加すると model が `resolved` に昇格し、`normalized_model` が本体と一致し、`other` 分類のダストカバー（実測 1 件: hifido `PL-50Lダストカバー`）は `categoryCompatible()` の veto も通り抜けるため、**懸念していた混同を実際に発生させます**。

唯一の実在する派生問題（別チケット、優先度低）: 管理レポート `listUnresolvedIdentityGroups`（`src/db/knowledge-catalog-remediation-repository.ts:106-135`、WHERE 句は 125-130 行）に `model_resolution_status='resolved'` 条件がないため、棚卸しレポート上で 7 グループが付属品と本体を同一行に集計します。検索リードモデルには影響しません。

### 7.2 `manufacturer_id` のハイフン不統一 — **棄却**

件数（ハイフン付き 18 / 無し 484 / `brand-*` 28、計 530）は正しいものの、**欠陥ではありません**。2つの生成元の決定的な出力です。ハイフンの有無に依存するコードは存在しません（書き込みは `manufacturerIdForFilter()`、読み出しは `manufacturerFilterIds()`（`src/db/product-search-repository.ts:179`）で、どちらも `manufacturers.ts` の同じ関数を経由）。

例外は 2 件のみで、これらは別問題です: `d-sign`（`d:sign ディーサイン` の `:` が除去対象外）と `y-039-acoustic`（N-4 の HTML エンティティ未デコード）。

### 7.3 hifido `10号メタルリール` のブランド捏造 — **棄却**

N-3 参照。実際に異なるブランドの商品であり、解決は正しい。

---

## 8. 推奨実行順序

依存関係を考慮した順序です。**P0-2 の機構特定を飛ばさないでください** — 非決定性が残ったままルールを直すと、修正の効果が測定できません。

> **進捗（2026-08-22）**: P0 の 4 項目は対応済みです — P0-1 は所見を訂正のうえ (A) を選択
> （hifido のみ実 HTML 待ちで残置）、P0-2 はカテゴリ側の機構を特定して修正、P0-3 と P0-4 は
> 実装＋バックフィル済み。§3（G-1 / G-2 / G-3）も対応済みで、G-3 は指示どおり
> 「粗いバケットを写像しない」を不変条件としてテストに固定しました。以下の表の該当行は
> 履歴として残しています。

| 順 | 項目 | 影響件数 | 種別 |
| ---: | --- | ---: | --- |
| 1 | **N-1** hifido レコード部門の除外 | **1,771**（21.1%） | クローラ範囲 |
| 2 | ~~**P0-3** `category_ids` の二重表現を解消~~ ✅ | 3,053 | 1行修正 |
| 3 | ~~**P0-2** 非決定性の**機構特定**~~ ✅（カテゴリ側は修正済み。メーカー側は N-3） | 655+ | 調査 |
| 4 | ~~**G-1** `category-rules.ts:111` からスピーカー削除~~ ✅ | 48〜54 が凍結解除、~500 が補完対象に | 1行修正 |
| 5 | **N-2** `MANUFACTURER_SOURCE` にブランド追加 | **5,955 が同定経路に到達**（71%） | データ追加 |
| 6 | **N-3** `manufacturer_id` 書き込みの一貫性 | 1,549 + 2,272 | 2箇所修正 |
| 7 | **E-3** hifido `CATEGORY_RE` のアンカー | 68（N-1 実施時は自動解消） | パーサ修正 |
| 8 | **E-1** ワイヤレスのルール追加 | 43 | ルール追加 |
| 9 | **N-4** プレースホルダーブランドのストップリスト | 85（公開ファセット汚染） | ストップリスト |
| 10 | **E-2** `cable_other` 過剰マッチの**調査**（修正は調査後） | 53 | 調査 |
| 11 | ~~**P0-4** 未分類センチネル ID の分離~~ ✅ | 5,047（UX） | 大（migration 必須） |
| 12 | ~~**P0-1** 詳細補完の実装 or 削除の決定~~ ✅ (A) を選択（hifido は残置） | 5,047 の回収経路 | 大 |
| 13 | ~~**G-2** DAP のタイトル判定~~ ✅ | 最低 40+ | ルール追加 |
| 14 | **N-5** 末尾和文製品種別語の注釈ルール | 56 | ルール追加 |

**各ステップ後に `npm run verify` を1回実行し、変更をコミットしてから次に進んでください。**

---

## 9. 付属データ

`hifiscout-defects.csv` — 欠陥コード別・`listing_id` 単位の一覧（12 分類、延べ 7,970 行、実出品 4,717 件）。

列: `defect_code`, `severity`, `listing_id`, `shop_key`, `title`, `current_primary_category_id`, `current_manufacturer_id`, `normalized_model`, `raw_category`, `detail`, `expected`

| 欠陥コード | 件数 | 対応する節 |
| --- | ---: | --- |
| `D11-UNCLASSIFIED-DUAL-REPR` | 1,994 | P0-3 |
| `D01-MUSIC-SOFTWARE` | 1,771 | N-1 |
| `D09-MFR-STATUS-CONTRADICTION` | 1,549 | N-3 |
| `D02-DEGENERATE-MODEL` | 1,451 | N-1 |
| `D07-NONDETERMINISTIC-CATEGORY` | 343 | P0-2 |
| `D08-NONDETERMINISTIC-MFR` | 302 | P0-2 / N-3 |
| `D03-SPEAKER-BUCKET-LOST` | 298 | G-1 |
| `D12-IDENTITY-NOT-MERGED` | 141 | N-5（※過大。実際に分裂しているのは 56 件） |
| `D06-CATEGORY-BLEED` | 68 | E-3 |
| `D04-TWS-AS-WIRED` | 26 | E-1 |
| `D05-BT-HP-AS-WIRED` | 17 | E-1 |
| `D10-ACCESSORY-IDENTITY-COLLISION` | 10 | **棄却（§7.1）— 対応不要** |

> `D10` は §7.1 のとおり棄却されました。CSV には残していますが**修正しないでください**。
> `D12` は検証前の基準で抽出したため過大です。実際に検索結果が分裂しているのは 23 グループ / 56 件です（N-5）。
