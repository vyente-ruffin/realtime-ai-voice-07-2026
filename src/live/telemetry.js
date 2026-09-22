/** Privacy-safe browser diagnostics schema; never accept SDP, speech or arbitrary errors. */
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const nullableNumber = value => value === null || number(value);
const choices = values => value => values.includes(value);
const types = new Set([
  "connection.started", "connection.open", "connection.state", "connection.channel.closed", "connection.ending",
  "connection.close.requested", "connection.close.timeout", "connection.lost",
  "connection.error", "connection.page.hidden", "connection.page.exit", "call.stats", "call.ended",
]);
const fields = {
  reason: choices(["remote_channel_closed", "remote_session_closed", "peer_failed", "peer_disconnected",
    "user_end", "close_timeout", "session_replaced", "connection_error", "page_exit", "unknown"]),
  requested: value => typeof value === "boolean",
  connectionState: choices(["new", "connecting", "connected", "disconnected", "failed", "closed"]),
  iceState: choices(["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]),
  channelState: choices(["connecting", "open", "closing", "closed"]),
  errorName: choices(["Error", "NotAllowedError", "NotFoundError", "NotReadableError", "AbortError",
    "TimeoutError", "InvalidStateError", "OperationError", "RTCError", "SyntaxError", "TypeError", "UnknownError"]),
  statsStatus: choices(["ok", "unavailable", "error"]),
  packetsReceived: nullableNumber, bytesReceived: nullableNumber,
  jitterSeconds: nullableNumber, roundTripTimeSeconds: nullableNumber,
  audioReceived: value => value === null || typeof value === "boolean",
  sampledAt: nullableNumber,
};

/** Validate the entire batch before any durable write (RFC 9457 at the HTTP boundary). */
export function validateTelemetry(events, conversation) {
  const invalid = () => { throw Object.assign(new Error("Invalid telemetry batch."), { status: 400 }); };
  if (!Array.isArray(events) || !events.length || events.length > 50) invalid();
  for (const event of events) {
    if (!object(event) || Object.keys(event).some(key => !["id", "conversation", "session", "callId", "ts", "type", "detail"].includes(key)) ||
      !identifier(event.id) || !identifier(event.callId) || event.conversation !== conversation ||
      !identifier(event.conversation) || (event.session !== null && !identifier(event.session)) ||
      !Number.isSafeInteger(event.ts) || !number(event.ts) || !types.has(event.type) || !object(event.detail)) invalid();
    for (const [key, value] of Object.entries(event.detail))
      if (!Object.hasOwn(fields, key) || !fields[key](value)) invalid();
  }
  return events;
}
