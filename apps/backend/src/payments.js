const { randomUUID } = require("crypto");
const express = require("express");
const log = require("./log");

log.setErrorGroupCallback();

const app = express();
const port = Number(process.env.PORT || 4000);

app.use(express.json());
app.use((req, res, next) => {
  const requestId = req.get("x-request-id") || randomUUID();
  req.requestId = requestId;
  res.set("x-request-id", requestId);
  log.addTransactionAttributes({ "request.id": requestId });
  next();
});

app.get("/health", (_req, res) => {
  log.setTransactionName("Health/Check/Payments");
  log.addTransactionAttributes({
    "endpoint.type": "health",
    "endpoint.category": "system",
  });
  res.json({ status: "ok", service: "payments" });
});

app.post("/charge", (req, res) => {
  log.setTransactionName("Payments/Charge");
  
  const fail = Boolean(req.body?.fail);
  const amount = Number(req.body?.amount || 0);

  log.addTransactionAttributes({
    "payment.amount": amount,
    "payment.fail": fail,
    "endpoint.type": "charge",
    "business.payment_amount": amount,
  });
  
  log.recordMetric("Custom/Payments/Amount", amount);

  if (fail) {
    const error = new Error("Payment gateway unavailable");
    error.name = "PaymentGatewayError";
    
    log.noticeError(error, {
      requestId: req.requestId,
      "error.expected": true,
      "error.type": "payment_gateway_unavailable",
      "error.category": "learning",
      "payment.amount": amount,
    });
    
    log.addTransactionAttributes({
      "error.expected": true,
      "error.type": "payment_gateway_unavailable",
    });
    
    log.error("charge_failed", { requestId: req.requestId, amount });
    
    return res.status(503).json({
      error: "payment_gateway_unavailable",
      message: error.message,
      requestId: req.requestId,
    });
  }

  const charge = {
    chargeId: randomUUID(),
    status: "captured",
    amount,
    requestId: req.requestId,
  };
  log.info("charge_captured", { requestId: req.requestId, ...charge });
  res.json(charge);
});

app.listen(port, "0.0.0.0", () => {
  log.info("payments_started", { port });
});
