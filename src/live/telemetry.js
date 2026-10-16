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
  "connection.microphone", "connection.playback", "connection.session.started", "connection.session.closed",
  "connection.updates.lost", "connection.audio_context", "telemetry.gap",
  // Send audit: one row per append sent to GPT-Live and per acknowledgment or rejection of one.
  "model.send", "model.ack", "model.rejected",
]);
// Provider error type/code are documented identifiers (GPT-Live reference, "Error handling"); never the message.
const providerIdentifier = value => typeof value === "string" && /^[a-z0-9_.]{1,100}$/.test(value);
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
  stage: choices(["conversation", "microphone", "audio_context", "offer", "session", "answer",
    "channel", "event", "provider", "playback"]),
  // Browser-observed states only: "playing" means the media element started, not that anyone heard it.
  microphoneState: choices(["live", "muted", "disabled", "ended"]),
  // paused/stalled/ended mirror HTMLMediaElement events (HTML Standard, "Media elements").
  playbackState: choices(["track_received", "playing", "blocked", "paused", "stalled", "ended"]),
  audioContextState: choices(["suspended", "running", "closed", "interrupted"]),
  providerErrorType: providerIdentifier, providerErrorCode: providerIdentifier,
  commandCorrelated: value => typeof value === "boolean",
  providerCloseReason: choices(["close_requested", "expired", "content", "remote_hangup", "connection_lost", "unknown"]),
  droppedEvents: number, failedFlushes: number, beaconRefused: number,
  // Send audit fields: identifiers, a purpose label and sizes/times only; never the content text.
  eventType: choices(["session.thinking.append", "session.commentary.append", "session.instructions.append",
    "session.thinking.appended", "session.commentary.appended", "session.instructions.appended"]),
  eventId: identifier,
  delegationId: value => value === null || identifier(value),
  purpose: choices(["memory", "clock", "job-status", "result", "consent", "cut-off", "save-confirmation", "instructions", "typed", "unknown"]),
  contentLength: number, sentAt: number, ackAt: number, ackMs: number,
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
