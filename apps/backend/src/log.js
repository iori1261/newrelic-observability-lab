function getNewRelic() {
  if (!process.env.NEW_RELIC_LICENSE_KEY) {
    return null;
  }

  try {
    return require("newrelic");
  } catch {
    return null;
  }
}

function write(level, message, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: process.env.NEW_RELIC_APP_NAME || process.env.SERVICE_NAME || "api",
    message,
    ...fields,
  };

  const line = JSON.stringify(record);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function addTransactionAttributes(attributes) {
  const newrelic = getNewRelic();
  if (!newrelic) {
    return;
  }

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) {
      newrelic.addCustomAttribute(key, value);
    }
  }
}

function noticeError(error, attributes) {
  const newrelic = getNewRelic();
  if (newrelic) {
    newrelic.noticeError(error, attributes);
  }
}

function setTransactionName(name) {
  const newrelic = getNewRelic();
  if (newrelic) {
    newrelic.setTransactionName(name);
  }
}

function recordMetric(name, value) {
  const newrelic = getNewRelic();
  if (newrelic) {
    newrelic.recordMetric(name, value);
  }
}

function setErrorGroupCallback() {
  const newrelic = getNewRelic();
  if (!newrelic) {
    return;
  }

  newrelic.setErrorGroupCallback((metadata) => {
    const expected = metadata.customAttributes?.["error.expected"];
    const errorType = metadata.customAttributes?.["error.type"];
    
    if (expected) {
      return `expected/${errorType || "general"}`;
    }
    
    return errorType || "unexpected/general";
  });
}

module.exports = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
  addTransactionAttributes,
  noticeError,
  setTransactionName,
  recordMetric,
  setErrorGroupCallback,
};
