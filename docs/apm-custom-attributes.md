# APM 学習ガイド（カスタム属性とトランザクション命名）

このガイドでは、New Relic APM の**カスタム属性**と**トランザクション命名**を使って、より詳細なパフォーマンス分析を学びます。

前提: [first-run.md](first-run.md) を完了していること。

---

## カスタム属性とは

New Relic が自動で記録する情報（URL、レスポンス時間など）に加えて、**アプリケーション固有の情報**を追加できます。

### 標準属性 vs カスタム属性

| 種類 | 例 | 記録される場所 |
|---|---|---|
| **標準属性** | `duration`、`name`、`httpResponseCode` | New Relic エージェントが自動記録 |
| **カスタム属性** | `order.sku`、`order.amount`、`error.expected` | アプリケーションが明示的に記録 |

### このアプリで記録しているカスタム属性

#### ビジネス情報

| 属性名 | 型 | 例 | 用途 |
|---|---|---|---|
| `order.sku` | 文字列 | `demo-item` | 商品コード |
| `order.quantity` | 数値 | `1` | 数量 |
| `order.amount` | 数値 | `1200` | 金額 |
| `business.revenue` | 数値 | `1200` | 売上（メトリクスとしても記録） |

#### リクエスト情報

| 属性名 | 型 | 例 | 用途 |
|---|---|---|---|
| `request.id` | 文字列 | `uuid` | リクエスト全体の追跡 ID |
| `client.action` | 文字列 | `create_order` | クライアント側の操作名 |
| `client.platform` | 文字列 | `iOS`, `script` | 呼び出し元 |

#### エラー分類

| 属性名 | 型 | 例 | 用途 |
|---|---|---|---|
| `error.expected` | 真偽値 | `true` | 学習用エラーか本番エラーか |
| `error.type` | 文字列 | `server_error` | エラーの種類 |
| `error.category` | 文字列 | `learning`, `production` | エラーのカテゴリ |

#### エンドポイント情報

| 属性名 | 型 | 例 | 用途 |
|---|---|---|---|
| `endpoint.type` | 文字列 | `create`, `read`, `health` | エンドポイントの種類 |
| `endpoint.category` | 文字列 | `system`, `business` | エンドポイントのカテゴリ |

---

## 1. カスタム属性で絞り込む（10 分）

### ステップ 1: 負荷を流す

```bash
make load-errors
```

### ステップ 2: NRQL で特定の SKU だけ抽出する

**Query your data** を開いて実行:

```sql
SELECT count(*), average(duration), percentile(duration, 95)
FROM Transaction
WHERE appName = 'mini-app-api' AND order.sku IS NOT NULL
FACET order.sku
SINCE 30 minutes ago
```

**結果**: `demo-item`、`bulk-item`、`fail-item` など、商品ごとの件数と遅さが出ます。

### ステップ 3: エラーだけを商品別に見る

```sql
SELECT count(*)
FROM Transaction
WHERE appName = 'mini-app-api' AND error IS true
FACET order.sku
SINCE 30 minutes ago
```

**結果**: `fail-item` だけエラー率が高いことが分かります。

### ステップ 4: クライアント別に絞り込む

```sql
SELECT count(*), percentage(count(*), WHERE error IS true)
FROM Transaction
WHERE appName = 'mini-app-api'
FACET client.platform
SINCE 30 minutes ago
```

**結果**: `script`、`iOS`、`unknown` など、呼び出し元ごとのエラー率が出ます。

---

## 2. カスタムトランザクション名（15 分）

New Relic は通常、URL から自動でトランザクション名を付けます（例: `WebTransaction/Expressjs/POST//orders`）。  
このアプリでは、**もっと分かりやすい名前**を手動で設定しています。

### トランザクション名の一覧

| エンドポイント | 標準の名前（自動） | カスタム名（手動） |
|---|---|---|
| `GET /health` | `WebTransaction/Expressjs/GET//health` | `Health/Check` |
| `POST /orders` | `WebTransaction/Expressjs/POST//orders` | `Orders/Create` |
| `POST /orders/slow` | `WebTransaction/Expressjs/POST//orders/slow` | `Orders/Create/Slow` |
| `GET /orders/:id` | `WebTransaction/Expressjs/GET//orders/:id` | `Orders/Get` |
| `POST /chaos/error` | `WebTransaction/Expressjs/POST//chaos/error` | `Chaos/ServerError` |
| `POST /chaos/dependency` | `WebTransaction/Expressjs/POST//chaos/dependency` | `Chaos/DependencyFailure` |

### なぜカスタム名を使うのか

- **短くて読みやすい**: 長い URL より一目で分かる
- **グループ化しやすい**: `Orders/*` で注文関連をまとめて見られる
- **階層構造**: `/` で親子関係を表現できる

### NRQL でトランザクション名を使う

```sql
SELECT average(duration), percentile(duration, 95), count(*)
FROM Transaction
WHERE appName = 'mini-app-api'
FACET name
SINCE 30 minutes ago
```

**結果**: `Orders/Create`、`Orders/Create/Slow`、`Chaos/ServerError` など、カスタム名で集計されます。

### 遅いトランザクションを特定する

```sql
SELECT average(duration) as 'Average', percentile(duration, 95) as 'P95'
FROM Transaction
WHERE appName = 'mini-app-api'
FACET name
SINCE 30 minutes ago
ORDER BY percentile(duration, 95) DESC
```

**結果**: `Orders/Create/Slow` が一番遅いと分かります。

---

## 3. ビジネスメトリクスの記録（10 分）

カスタム属性は「1 リクエストごとの情報」ですが、**メトリクス**は「数値の集計」を直接記録できます。

### このアプリで記録しているメトリクス

| メトリクス名 | 意味 | 記録している値 |
|---|---|---|
| `Custom/Orders/Amount` | 注文金額 | `order.amount` |
| `Custom/Payments/Amount` | 決済金額 | `payment.amount` |

### NRQL でメトリクスを見る

```sql
SELECT sum(newrelic.timeslice.value) as 'Total Revenue'
FROM Metric
WHERE metricTimesliceName = 'Custom/Orders/Amount'
SINCE 30 minutes ago
TIMESERIES
```

**結果**: 時系列で売上合計が出ます。

### カスタム属性との使い分け

| 用途 | カスタム属性 | メトリクス |
|---|---|---|
| リクエスト単位の情報 | ◯ | × |
| 集計値（合計・平均） | △（NRQL で計算） | ◯（事前計算） |
| NRQL でフィルタ | ◯ | △（制限あり） |
| 保存期間 | 8 日〜（プラン次第） | 長期保存向き |

このアプリでは学習用なので、両方記録しています。本番では用途に応じて選びます。

---

## 4. Distributed Tracing でカスタム属性を見る（10 分）

### ステップ 1: トレースを開く

```bash
curl -X POST http://127.0.0.1:8080/orders \
  -H 'content-type: application/json' \
  -H 'x-client-action: demo' \
  -d '{"sku":"premium-item","quantity":3}'
```

1〜3 分待ってから:

1. **APM & Services** → `mini-app-api` → **Distributed tracing** を開く
2. 最近のトレースを 1 つクリック
3. **Attributes** タブを開く

### ステップ 2: カスタム属性を確認する

次の属性が記録されているはずです:

- `order.sku = premium-item`
- `order.quantity = 3`
- `order.amount = 3600`
- `client.action = demo`
- `request.id = (uuid)`

### ステップ 3: 同じ request.id でログを検索する

1. `request.id` の値をコピー
2. **Logs** を開く
3. 次のクエリで検索:

```
requestId:"(コピーした uuid)"
```

**結果**: 1 つのリクエストに関連する全ログ（api と payments）が出ます。

---

## 5. エラー属性の活用（15 分）

### expected エラーと unexpected エラーを分ける

```sql
SELECT count(*)
FROM TransactionError
WHERE appName = 'mini-app-api'
FACET error.expected, error.type
SINCE 30 minutes ago
```

**結果**:

| error.expected | error.type | count |
|---|---|---|
| `true` | `server_error` | 約 15 |
| `true` | `dependency_failure` | 約 15 |
| `false` | `unhandled_error` | 0（正常時） |

### エラーカテゴリ別に集計する

```sql
SELECT count(*)
FROM TransactionError
WHERE appName IN ('mini-app-api', 'mini-app-payments')
FACET error.category, appName
SINCE 30 minutes ago
```

**結果**: `learning` カテゴリのエラーは学習用、`production` カテゴリは本番用と区別できます。

### 依存先の失敗を特定する

```sql
SELECT count(*)
FROM TransactionError
WHERE error.type = 'dependency_failure'
FACET dependency.name
SINCE 30 minutes ago
```

**結果**: `payments` が原因だと分かります。

---

## 6. ダッシュボードを作る（20 分）

カスタム属性を使って、ビジネス視点のダッシュボードを作ります。

### ステップ 1: 新しいダッシュボードを作る

1. **Dashboards** → **Create a dashboard** をクリック
2. 名前: `mini-app-api - Business Metrics`

### ステップ 2: ウィジェットを追加する

#### ウィジェット 1: エラー率（時系列）

```sql
SELECT percentage(count(*), WHERE error IS true) as 'Error Rate %'
FROM Transaction
WHERE appName = 'mini-app-api'
SINCE 30 minutes ago
TIMESERIES
```

**Chart type**: Line

#### ウィジェット 2: 売上合計（時系列）

```sql
SELECT sum(order.amount) as 'Total Revenue'
FROM Transaction
WHERE appName = 'mini-app-api' AND order.amount IS NOT NULL
SINCE 30 minutes ago
TIMESERIES
```

**Chart type**: Area

#### ウィジェット 3: 商品別件数（円グラフ）

```sql
SELECT count(*)
FROM Transaction
WHERE appName = 'mini-app-api' AND order.sku IS NOT NULL
FACET order.sku
SINCE 30 minutes ago
```

**Chart type**: Pie

#### ウィジェット 4: クライアント別エラー率（テーブル）

```sql
SELECT count(*) as 'Total', 
       percentage(count(*), WHERE error IS true) as 'Error Rate %'
FROM Transaction
WHERE appName = 'mini-app-api'
FACET client.platform
SINCE 30 minutes ago
```

**Chart type**: Table

### ステップ 3: ダッシュボードを保存して確認する

```bash
make load-errors
```

1〜3 分後、ダッシュボードをリロードすると、グラフが動いているはずです。

---

## 7. 実践: パフォーマンス劣化を調査する（15 分）

### シナリオ: 特定の商品だけ遅い

```bash
for i in {1..20}; do
  curl -sS -X POST http://127.0.0.1:8080/orders/slow \
    -H 'content-type: application/json' \
    -d '{"sku":"slow-item","quantity":1}' > /dev/null
done

for i in {1..20}; do
  curl -sS -X POST http://127.0.0.1:8080/orders \
    -H 'content-type: application/json' \
    -d '{"sku":"fast-item","quantity":1}' > /dev/null
done
```

1〜3 分待ってから、調査します。

#### 調査ステップ 1: 全体の遅さを確認

**APM > Summary** で Response time が上がっているか確認。

#### 調査ステップ 2: 商品別に遅さを分ける

```sql
SELECT average(duration) as 'Average', percentile(duration, 95) as 'P95'
FROM Transaction
WHERE appName = 'mini-app-api' AND order.sku IS NOT NULL
FACET order.sku
SINCE 30 minutes ago
```

**結果**: `slow-item` だけ P95 が 2 秒超えている。

#### 調査ステップ 3: トランザクション名でも確認

```sql
SELECT average(duration), percentile(duration, 95), count(*)
FROM Transaction
WHERE appName = 'mini-app-api'
FACET name
SINCE 30 minutes ago
ORDER BY percentile(duration, 95) DESC
```

**結果**: `Orders/Create/Slow` が遅い。

#### 調査ステップ 4: 遅いトレースを見る

1. **Distributed tracing** を開く
2. **Filter by** で `order.sku = slow-item` を追加
3. 遅いトレースを 1 つ開く
4. どの span が長いか確認

**結果**: api 側の処理に 2 秒かかっている。payments は普通。

---

## 8. まとめ

### このガイドで身につけたこと

- カスタム属性でビジネス情報を記録・分析する
- トランザクション名をカスタマイズして可読性を上げる
- ビジネスメトリクスで売上などを集計する
- エラー属性で expected/unexpected を分類する
- ダッシュボードでカスタム属性を可視化する

### 実務で使える NRQL テンプレート

```sql
-- 商品別エラー率
SELECT count(*) as 'Total', 
       percentage(count(*), WHERE error IS true) as 'Error Rate %'
FROM Transaction
WHERE appName = 'YOUR_APP'
FACET your.custom.attribute
SINCE 1 hour ago

-- P95 が遅いトランザクション TOP 10
SELECT percentile(duration, 95) as 'P95'
FROM Transaction
WHERE appName = 'YOUR_APP'
FACET name
SINCE 1 hour ago
ORDER BY percentile(duration, 95) DESC
LIMIT 10

-- 売上を時系列で
SELECT sum(your.amount.attribute) as 'Revenue'
FROM Transaction
WHERE appName = 'YOUR_APP'
SINCE 1 day ago
TIMESERIES 1 hour

-- エラーを属性別に分類
SELECT count(*)
FROM TransactionError
WHERE appName = 'YOUR_APP'
FACET your.error.type, your.error.category
SINCE 1 hour ago
```

### 次のステップ

- **アラートに組み込む**: カスタム属性を条件にしたアラート（例: `order.amount > 10000` のエラー）
- **Facet Cases を使う**: 複雑な条件分岐でグルーピング
- **Log attributes との連携**: ログにも同じカスタム属性を入れて、横断検索
- **本番データで試す**: 職場のアプリに少しずつカスタム属性を追加して、分析の幅を広げる
