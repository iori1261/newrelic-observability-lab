const { randomUUID } = require("crypto");
const express = require("express");
const log = require("./log");

log.setErrorGroupCallback();

const app = express();
const port = Number(process.env.PORT || 8080);
const paymentsUrl = process.env.PAYMENTS_URL || "http://payments:4000";
// CORS は既定で無効。iOS アプリも curl もブラウザではないので不要で、
// 有効にすると利用者が開いた任意の Web ページから /chaos/* を起動できてしまう。
// ブラウザから試すときだけ .env の CORS_ORIGIN にオリジンを明示する。
const corsOrigin = process.env.CORS_ORIGIN || "";

const orders = new Map();

// ヘッダーの中身はログと New Relic の属性にそのまま入り、取り込み量（無料枠 100 GB）を
// 消費する。呼び出し側が巨大な値や制御文字を送れないよう、長さと文字種を先に絞る。
const MAX_HEADER_VALUE = 100;
const MAX_SKU_LENGTH = 64;
// 負荷シナリオを何度も流すと注文が溜まり続けるので、古いものから捨てる。
const MAX_ORDERS = 1000;

function safeHeader(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.replace(/[^\w.:@/-]/g, "").slice(0, MAX_HEADER_VALUE);
  return cleaned || fallback;
}

function applyCors(res) {
  if (!corsOrigin) {
    return;
  }
  res.set("access-control-allow-origin", corsOrigin);
  res.set("vary", "origin");
}

function rememberOrder(order) {
  orders.set(order.id, order);
  while (orders.size > MAX_ORDERS) {
    const oldest = orders.keys().next().value;
    orders.delete(oldest);
  }
}

app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  const requestId = safeHeader(req.get("x-request-id"), randomUUID());
  req.requestId = requestId;
  req.clientAction = safeHeader(req.get("x-client-action"), "unknown");
  req.clientPlatform = safeHeader(req.get("x-client-platform"), "unknown");
  res.set("x-request-id", requestId);
  res.set("access-control-expose-headers", "x-request-id");
  applyCors(res);

  log.addTransactionAttributes({
    "request.id": requestId,
    "client.action": req.clientAction,
    "client.platform": req.clientPlatform,
  });

  const started = Date.now();
  res.on("finish", () => {
    log.info("http_request", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      clientAction: req.clientAction,
      clientPlatform: req.clientPlatform,
    });
  });

  next();
});

app.options("*", (_req, res) => {
  if (!corsOrigin) {
    return res.status(405).end();
  }

  applyCors(res);
  res.set("access-control-allow-headers", "content-type, x-request-id, x-client-action, x-client-platform");
  res.set("access-control-allow-methods", "GET,POST,OPTIONS");
  res.status(204).end();
});

app.get("/health", (_req, res) => {
  log.setTransactionName("Health/Check");
  log.addTransactionAttributes({
    "endpoint.type": "health",
    "endpoint.category": "system",
  });
  
  res.json({
    status: "ok",
    service: "api",
    time: new Date().toISOString(),
    newRelic: {
      guide: "APM > Summary で Throughput（処理量）の増加を確認できます",
      screens: ["APM > Summary", "APM > Transactions"],
      nrql: "SELECT count(*) FROM Transaction WHERE name = 'Health/Check' SINCE 30 minutes ago",
    },
  });
});

app.post("/orders", async (req, res) => {
  log.setTransactionName("Orders/Create");
  await createOrder(req, res, { delayMs: 0, failPayment: false });
});

app.post("/orders/slow", async (req, res) => {
  log.setTransactionName("Orders/Create/Slow");
  await createOrder(req, res, { delayMs: 2000, failPayment: false });
});

app.get("/orders/:id", (req, res) => {
  log.setTransactionName("Orders/Get");
  const order = orders.get(req.params.id);
  
  log.addTransactionAttributes({
    "endpoint.type": "read",
    "order.found": !!order,
  });
  
  if (!order) {
    return res.status(404).json({
      error: "order_not_found",
      requestId: req.requestId,
      newRelic: {
        guide: "404 エラーは expected error として分類されます。Errors inbox で確認できます",
        screens: ["Errors inbox", "APM > Errors"],
      },
    });
  }

  res.json({
    ...order,
    newRelic: {
      guide: "Logs で requestId を検索すると、この注文の作成から取得までの全ログが見られます",
      screens: ["Logs", "Distributed tracing"],
      nrql: `SELECT * FROM Transaction WHERE request.id = '${req.requestId}' SINCE 1 hour ago`,
    },
  });
});

app.post("/chaos/error", (req, res) => {
  log.setTransactionName("Chaos/ServerError");
  
  const error = new Error("Intentional API failure for New Relic verification");
  error.name = "IntentionalServerError";
  
  log.noticeError(error, {
    requestId: req.requestId,
    scenario: "server_error",
    "error.expected": true,
    "error.type": "server_error",
    "error.category": "learning",
    "chaos.endpoint": "/chaos/error",
  });
  
  log.addTransactionAttributes({
    "error.expected": true,
    "error.type": "server_error",
    "chaos.scenario": "server_error",
  });
  
  log.error("chaos_server_error", { requestId: req.requestId });
  
  res.status(500).json({
    error: "intentional_server_error",
    message: error.message,
    requestId: req.requestId,
    newRelic: {
      guide: "これは expected error（意図的なエラー）です。Errors inbox で 'expected/server_error' グループを確認できます",
      screens: [
        "Errors inbox（エラーグループを確認）",
        "APM > Summary（Error rate の増加を確認）",
        "APM > Errors（スタックトレースを確認）"
      ],
      nrql: "SELECT count(*) FROM TransactionError WHERE error.type = 'server_error' FACET error.expected SINCE 30 minutes ago",
      tips: [
        "Error rate はエラー「件数」ではなく「割合」で見ます",
        "Throughput も同時に確認して、リクエスト増加によるエラー増加か、本当のバグかを判断します",
      ],
    },
  });
});

app.post("/chaos/dependency", async (req, res) => {
  log.setTransactionName("Chaos/DependencyFailure");
  log.addTransactionAttributes({
    "chaos.scenario": "dependency_failure",
    "endpoint.type": "chaos",
  });
  await createOrder(req, res, { delayMs: 0, failPayment: true });
});

app.use((error, req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  
  const isExpected = status < 500 || error.expected;
  
  log.noticeError(error, {
    requestId: req.requestId,
    "error.expected": isExpected,
    "error.type": isExpected ? "client_error" : "unhandled_error",
    "error.status": status,
  });
  
  log.addTransactionAttributes({
    "error.expected": isExpected,
    "error.type": isExpected ? "client_error" : "unhandled_error",
  });
  
  log.error("unhandled_error", {
    requestId: req.requestId,
    status,
    message: error.message,
  });
  
  res.status(status).json({
    error: status >= 500 ? "unhandled_error" : "bad_request",
    message: error.message,
    requestId: req.requestId,
  });
});

async function createOrder(req, res, { delayMs, failPayment }) {
  const sku = String(req.body?.sku || "demo-item").slice(0, MAX_SKU_LENGTH);
  const quantity = Math.min(Math.max(Number(req.body?.quantity) || 1, 1), 100);
  const amount = quantity * 1200;

  log.addTransactionAttributes({
    "order.sku": sku,
    "order.quantity": quantity,
    "order.amount": amount,
    "order.slow": delayMs > 0,
    "order.failPayment": failPayment,
    "endpoint.type": "create",
    "business.revenue": amount,
  });
  
  log.recordMetric("Custom/Orders/Amount", amount);

  if (delayMs > 0) {
    log.info("slow_order_delay", { requestId: req.requestId, delayMs });
    await sleep(delayMs);
  }

  try {
    const charge = await chargePayment({
      amount,
      fail: failPayment,
      requestId: req.requestId,
    });

    const order = {
      id: randomUUID(),
      sku,
      quantity,
      amount,
      status: "paid",
      chargeId: charge.chargeId,
      requestId: req.requestId,
      createdAt: new Date().toISOString(),
    };
    rememberOrder(order);

    log.info("order_created", {
      requestId: req.requestId,
      orderId: order.id,
      sku,
      quantity,
      amount,
    });
    
    const guide = {
      newRelic: {
        guide: delayMs > 0 
          ? "遅延が発生しました。APM > Transactions で Response time を確認し、Distributed tracing でどこに時間がかかっているか特定できます"
          : "正常な注文です。Distributed tracing で mini-app-api から mini-app-payments への呼び出しを確認できます",
        screens: [
          "Distributed tracing（サービス間の呼び出しを追跡）",
          "APM > Summary（Response time と Throughput を確認）",
          "APM > External services（payments サービスへの依存を確認）",
          "Logs（requestId で検索）"
        ],
        nrql: delayMs > 0
          ? "SELECT average(duration), percentile(duration, 95) FROM Transaction WHERE name = 'Orders/Create/Slow' SINCE 30 minutes ago"
          : `SELECT * FROM Span WHERE request.id = '${req.requestId}' SINCE 1 hour ago`,
        tips: delayMs > 0 ? [
          "Response time が長いですが、Error rate は上がっていません",
          "P95（95パーセンタイル）を見ると、遅いリクエストの影響がより明確になります",
        ] : [
          "request.id を使って、このリクエストに関連する全てのログとトレースを追跡できます",
        ],
      },
    };

    res.status(201).json({ ...order, ...guide });
  } catch (error) {
    const isExpectedFailure = failPayment;
    
    log.noticeError(error, {
      requestId: req.requestId,
      scenario: "dependency_failure",
      "error.expected": isExpectedFailure,
      "error.type": "dependency_failure",
      "error.category": isExpectedFailure ? "learning" : "production",
      "dependency.name": "payments",
      "dependency.url": paymentsUrl,
    });
    
    log.addTransactionAttributes({
      "error.expected": isExpectedFailure,
      "error.type": "dependency_failure",
    });
    
    log.error("order_payment_failed", {
      requestId: req.requestId,
      message: error.message,
    });
    
    res.status(502).json({
      error: "payment_failed",
      message: error.message,
      requestId: req.requestId,
      newRelic: {
        guide: "決済サービスが失敗しました。Distributed tracing で mini-app-payments 側のエラーを確認できます",
        screens: [
          "Distributed tracing（失敗した span を特定）",
          "Errors inbox（dependency_failure グループを確認）",
          "APM > External services（payments への呼び出し失敗率を確認）",
          "Service map（サービス間の依存関係を確認）"
        ],
        nrql: "SELECT count(*) FROM TransactionError WHERE error.type = 'dependency_failure' SINCE 30 minutes ago",
        tips: [
          "502 エラーは API 側の問題ではなく、依存サービス（payments）の問題です",
          "Distributed tracing で、どのサービスが失敗したか切り分けできます",
          "本番では、依存サービスの失敗に対するリトライやサーキットブレーカーを検討します",
        ],
      },
    });
  }
}

async function chargePayment({ amount, fail, requestId }) {
  const response = await fetch(`${paymentsUrl}/charge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: JSON.stringify({ amount, fail }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "payments unavailable");
  }

  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.listen(port, "0.0.0.0", () => {
  log.info("api_started", { port, paymentsUrl });
});
