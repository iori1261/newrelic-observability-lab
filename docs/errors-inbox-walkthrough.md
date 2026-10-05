# Errors inbox ウォークスルー（エラー追跡の学習）

New Relic の **Errors inbox**（エラー受信箱）を使って、エラーの検出・分類・調査を学ぶガイドです。

前提: `docker compose up -d` が動いていて、`.env` に License Key が入っていること。

---

## Errors inbox とは

**Errors inbox** は、アプリケーションで発生したエラーを自動的に分類・グループ化して表示する機能です。

### APM Errors との違い

| 画面 | 役割 | 使い分け |
|---|---|---|
| **Errors inbox** | エラーをチケットのように管理。未対応・対応中・解決済みを追跡 | チーム全体でエラー対応を管理したいとき |
| **APM > Errors** | 1 つのサービスのエラーを時系列で見る | 特定サービスのエラー詳細を調査するとき |

実務では、Errors inbox でエラーを発見 → APM Errors で詳細を調査、という流れが基本です。

---

## 1. エラーグループの基本（10 分）

### ステップ 1: まず正常系で基準を作る

```bash
make load
```

1〜3 分待ってから、[https://one.newrelic.com](https://one.newrelic.com) を開きます。

1. 左メニューの **Errors inbox** をクリック
2. 画面右上の時間範囲を **Last 30 minutes** にする
3. エラーがゼロまたはほとんど無いことを確認

これが「健全な状態」です。次にエラーを出して違いを見ます。

### ステップ 2: エラーを出してグループを見る

```bash
make load-errors
```

1〜3 分待ってから Errors inbox をリロードします。

次のようなエラーグループが現れます:

| グループ名の例 | 原因 | どこで起きたか |
|---|---|---|
| `expected/server_error` | 意図的な API エラー | mini-app-api |
| `expected/payment_gateway_unavailable` | 決済サービスの失敗 | mini-app-payments |
| `expected/dependency_failure` | 決済失敗による注文失敗 | mini-app-api（依存先起因） |

**重要**: グループ名の先頭が `expected/` になっているものは、**学習用の意図的なエラー** です。本番では `unexpected/` が出たときに優先対応します。

### ステップ 3: エラーグループを開く

1. `expected/server_error` をクリック
2. 次の情報を確認する:

| 項目 | 意味 | 見方 |
|---|---|---|
| **Error rate** | エラー率 | 約 30% になっているはず |
| **Occurrences** | 発生回数 | 何回同じエラーが起きたか |
| **Stack trace** | スタックトレース | どのコードで落ちたか（api.js の該当行） |
| **Attributes** | 属性 | `error.expected: true`、`error.type: server_error` など |

3. **Logs** タブに切り替えて、エラー発生時のログを見る
4. `request.id` をクリックして、そのリクエスト全体を追跡する

---

## 2. Expected vs Unexpected エラー（15 分）

このアプリでは、エラーを 2 種類に分類しています。

### Expected errors（期待されるエラー）

意図的に発生させているエラーです。New Relic では `expected/` で始まるグループに分類されます。

| シナリオ | エンドポイント | エラータイプ | 分類 |
|---|---|---|---|
| サーバーエラー学習用 | `POST /chaos/error` | `server_error` | `expected/server_error` |
| 決済失敗学習用 | `POST /chaos/dependency` | `dependency_failure` | `expected/dependency_failure` |
| 決済ゲートウェイ障害 | `POST /charge?fail=true` | `payment_gateway_unavailable` | `expected/payment_gateway_unavailable` |

### Unexpected errors（予期しないエラー）

本番で突然発生するバグや障害です。New Relic では `unexpected/` で始まるグループに分類されます。

| 例 | エラータイプ | 分類 |
|---|---|---|
| 存在しないルートへのアクセス | `not_found` | `unexpected/general` |
| 不正なリクエストボディ | `bad_request` | `expected/client_error` |
| キャッチされない例外 | `unhandled_error` | `unexpected/unhandled_error` |

### NRQL で分類を確認する

**Query your data** を開いて、次を実行します:

```sql
SELECT count(*) FROM TransactionError 
WHERE appName IN ('mini-app-api', 'mini-app-payments')
FACET error.type, error.expected 
SINCE 30 minutes ago
```

`error.expected = true` のエラーは学習用、`false` は本番で要対応、と判断できます。

---

## 3. エラーの切り分け（サービス境界）（10 分）

同じ「注文失敗」でも、原因は 2 パターンあります。

### パターン A: API 側の問題

```bash
curl -X POST http://127.0.0.1:8080/chaos/error \
  -H 'content-type: application/json' \
  -d '{}'
```

- **エラーグループ**: `expected/server_error`
- **発生場所**: `mini-app-api`
- **Distributed tracing**: api の span だけが赤い
- **責任**: API チーム

### パターン B: 決済サービスの問題

```bash
curl -X POST http://127.0.0.1:8080/chaos/dependency \
  -H 'content-type: application/json' \
  -d '{"sku":"fail-item","quantity":1}'
```

- **エラーグループ**: `expected/dependency_failure` と `expected/payment_gateway_unavailable`
- **発生場所**: `mini-app-payments` で失敗 → `mini-app-api` が 502 を返す
- **Distributed tracing**: payments の span が赤い
- **責任**: 決済チームまたは外部サービス

### 切り分けの手順

1. Errors inbox でエラーグループを開く
2. **Attributes** の `error.type` を見る:
   - `server_error` → API 側
   - `dependency_failure` → 呼び先側
   - `payment_gateway_unavailable` → 決済サービス側
3. **Distributed tracing** に飛んで、どの span が赤いか確認
4. **Service map** で依存関係を見る

実務では「自チームで直せるか、他チームに escalate するか」をここで判断します。

---

## 4. エラー率の読み方（15 分）

エラー「件数」ではなく「率」で見ることが重要です。

### なぜ率で見るのか

| 状況 | エラー件数 | リクエスト総数 | エラー率 | 判断 |
|---|---|---|---|---|
| 平常時 | 10 件 | 1,000 件 | 1% | 正常 |
| アクセス 10 倍 | 100 件 | 10,000 件 | 1% | **正常** |
| バグ混入後 | 100 件 | 1,000 件 | 10% | **異常** |

件数だけ見ると「10 倍に増えた！」と焦りますが、率が変わっていなければ健全です。

### NRQL でエラー率を出す

```sql
SELECT percentage(count(*), WHERE error IS true) FROM Transaction
WHERE appName = 'mini-app-api'
SINCE 30 minutes ago
TIMESERIES
```

- **約 30%** になっていれば、`make load-errors` の設定どおり
- **0%** なら、正常系だけが流れている
- **突然上がった** なら、デプロイやインフラ変更を疑う

### Summary と比較する

1. **APM & Services** → `mini-app-api` → **Summary** を開く
2. **Error rate** のグラフを見る
3. 同じ時間帯に **Throughput** が増えているか確認する

**Throughput も増えている** = アクセス増による自然な増加
**Throughput 変わらず Error rate だけ上昇** = バグや障害

---

## 5. エラー調査の実践（20 分）

実務の障害対応をシミュレーションします。

### シナリオ: エラー率が急上昇した

```bash
make load-errors
```

あなたは SRE で、アラートが飛んできました。

#### ステップ 1: 全体像を掴む（1 分）

1. **APM > Summary** を開く
2. **Error rate** が約 30% に上昇していることを確認
3. **Throughput** も増えているか確認（増えていれば、単なる負荷増の可能性）

#### ステップ 2: どのエラーが多いか特定する（2 分）

1. **Errors inbox** を開く
2. エラーグループを **Occurrences**（発生回数）で並び替える
3. 件数が多いグループを開く

#### ステップ 3: いつから起きているか確認する（2 分）

1. エラーグループ内の **Occurrences graph** を見る
2. 急に増えたタイミングを確認
3. そのタイミングにデプロイやインフラ変更があったか思い出す（実務では Slack や GitHub を確認）

#### ステップ 4: どこで落ちているか調べる（5 分）

1. **Stack trace** を見る
2. 落ちているファイル名と行番号を確認（例: `api.js:120`）
3. **Attributes** を見て、共通点を探す:
   - 特定の `order.sku` だけ？
   - 特定の `client.platform` だけ？

#### ステップ 5: 1 件を深掘りする（5 分）

1. エラー一覧から 1 件をクリック
2. **Distributed tracing** に飛ぶ
3. サービス間の呼び出しで、どこが失敗しているか確認
4. **Logs** に飛んで、前後のログを読む

#### ステップ 6: NRQL で傾向を出す（5 分）

```sql
SELECT count(*) FROM TransactionError
WHERE appName = 'mini-app-api' AND error.type = 'server_error'
FACET request.uri, order.sku
SINCE 1 hour ago
```

特定の URI や SKU に偏っていれば、それが原因の手がかりです。

---

## 6. アラートの設定（任意、10 分）

エラー率がしきい値を超えたら通知を受け取る設定です。

### ステップ 1: アラート条件を作る

1. **APM & Services** → `mini-app-api` を開く
2. 左メニューの **Alert conditions** をクリック
3. **Create alert condition** → **Use guided mode** を選ぶ
4. 次のように設定:

| 項目 | 値 |
|---|---|
| **Signal** | Error rate |
| **Threshold** | 5% 以上が 5 分間続いたら |
| **Condition name** | API error rate high |

### ステップ 2: 通知先を設定する

1. **Notification** で通知先を選ぶ（まずは自分のメールでよい）
2. 保存する

### ステップ 3: 発火を確認する

```bash
make load-errors
```

5 分待つと、メールが届くはずです。届かなければ、しきい値が高すぎます（30% のエラー率なので、5% なら発火するはず）。

---

## 7. よくある質問

### Q1: エラーグループ名が日本語で出ないのはなぜ？

A: New Relic はエラーメッセージやスタックトレースで自動分類しますが、このアプリでは `error.type` を使ってカスタム分類しています。日本語の説明は Attributes の中にあります。

### Q2: 404 エラーも Errors inbox に出る？

A: 設定次第です。このアプリでは、4xx は expected error として分類され、5xx とは別グループになります。

### Q3: エラーが出ているのに Errors inbox に現れない

A: 次を確認してください:

1. 時間範囲が正しいか（右上を **Last 30 minutes** に）
2. エラーが New Relic に送られているか（`docker compose logs api` に `401 invalid license key` が無いか）
3. 1〜3 分待ったか

### Q4: expected と unexpected の分類は自分で変えられる？

A: はい。`apps/backend/src/log.js` の `setErrorGroupCallback` を編集すれば、分類ルールを変更できます。

---

## 8. 次のステップ

- **ダッシュボードを作る**: エラー率・件数・サービス別の内訳を 1 画面に
- **NRQL を深める**: `FACET CASES` でエラータイプを条件分岐
- **Synthetics と組み合わせる**: 外から `/health` を監視して、ユーザーより先にエラーを検知
- **本番データを見る**: 職場のステージングや本番の Errors inbox で、実際のエラー対応を学ぶ

---

## まとめ

### この章で身につけたこと

- Errors inbox でエラーをグループ化して管理する
- Expected と unexpected エラーの違い
- エラー率を「件数」ではなく「割合」で見る
- Distributed tracing でサービス境界を切り分ける
- Stack trace と Attributes でエラーを深掘りする

### 実務で使える判断の型

1. エラー率が上がったら、まず Summary で Throughput も確認
2. Errors inbox でどのグループが多いか特定
3. Distributed tracing で責任の所在を切り分け
4. NRQL で傾向を出して、共通点を探す
5. 対応後、エラー率が下がったか確認

エラーは「出さない」ことが理想ですが、出たときに「早く見つけて、原因を特定して、直す」ができれば、SRE として十分です。
