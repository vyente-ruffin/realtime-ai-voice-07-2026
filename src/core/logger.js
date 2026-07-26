// Centralized logger (Engineering Standard #2).
// APPLICATIONINSIGHTS_CONNECTION_STRING set -> Azure Monitor; otherwise structured console.
// All application code imports from this file. Setup runs once.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let initialized = false;

async function setupOnce() {
  if (initialized) return;
  initialized = true;

  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    try {
      const { useAzureMonitor } = await import("@azure/monitor-opentelemetry");
      useAzureMonitor();
    } catch {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          logger: "core.logger",
          message:
            "APPLICATIONINSIGHTS_CONNECTION_STRING is set but @azure/monitor-opentelemetry is not installed; falling back to structured console output",
        }) + "\n"
      );
    }
  }
}

function emit(name, level, message, attributes) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    logger: name,
    message,
    ...attributes,
  });
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

export async function getLogger(name) {
  await setupOnce();
  return {
    debug: (message, attributes) => emit(name, "debug", message, attributes),
    info: (message, attributes) => emit(name, "info", message, attributes),
    warn: (message, attributes) => emit(name, "warn", message, attributes),
    error: (message, attributes) => emit(name, "error", message, attributes),
  };
}
