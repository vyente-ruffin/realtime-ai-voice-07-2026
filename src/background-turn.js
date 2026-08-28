// Split a turn at a hard latency boundary without cancelling the underlying
// work. Promise.race only chooses which result the caller observes first; the
// work promise keeps running and is exposed as `continuation` for completion
// delivery on a separate path.

const PROVENANCE_LABELS = new Set([
  "user-authored/app-transcribed",
  "assistant-authored",
  "application bootstrap",
  "system/developer instruction",
  "synthetic test input",
  "synthetic test output",
  "server-injected",
  "tool-generated",
  "quoted material",
  "unknown/needs review",
]);

export function normalizeProvenance(value) {
  return PROVENANCE_LABELS.has(value) ? value : "unknown/needs review";
}

export function provenanceForTurnPayload(value) {
  return normalizeProvenance(value);
}

export function answerProvenanceForQuestion(questionProvenance) {
  return questionProvenance === "synthetic test input"
    ? "synthetic test output"
    : "assistant-authored";
}

// A speech receipt is meaningful only when at least one live SSE browser could
// receive the corresponding command. Direct/server-only probes must not leave
// stale expectations for the next real browser utterance.
export function rememberExpectedSpeechForClients(queue, connectedClients, receipt) {
  if (!Array.isArray(queue)) throw new TypeError("queue must be an array");
  if (!Number.isInteger(connectedClients) || connectedClients < 0) {
    throw new TypeError("connectedClients must be a non-negative integer");
  }
  if (connectedClients === 0) return false;
  queue.push(receipt);
  return true;
}

export function cancellationNeedsReplacement(result) {
  return !result?.sent || !result.completed || result.stopReason !== "cancelled";
}

export function shouldDetachAtBoundary(startedAtMs, nowMs, thresholdMs) {
  return Number.isFinite(startedAtMs)
    && Number.isFinite(nowMs)
    && Number.isFinite(thresholdMs)
    && thresholdMs >= 0
    && nowMs - startedAtMs >= thresholdMs;
}

// A failed request may no longer own the global foreground slot: a concurrent
// request can already have rotated in a newer brain. Only an empty slot or the
// exact failed owner may initiate replacement.
export function failureReplacementNeeded(currentBrain, failedBrain) {
  return currentBrain == null || currentBrain === failedBrain;
}

export function shouldBootstrapBrain(reason) {
  return reason !== "background-replacement"
    && reason !== "cancellation-replacement"
    && reason !== "failure-replacement"
    && reason !== "standby-replacement";
}

export function taskHandleForSession(sessionId) {
  if (typeof sessionId !== "string" || !/^[a-f0-9]{8}-/i.test(sessionId)) {
    throw new TypeError("sessionId must begin with 8 hexadecimal characters");
  }
  return `voice-${sessionId.slice(0, 8).toLowerCase()}`;
}

// The spoken acknowledgment intentionally includes the same short application
// handle persisted in background-turns.log. It is short enough for TTS while
// still mapping one-to-one to the full ACP session id stored beside it.
export function formatTaskReceipt(handle) {
  if (typeof handle !== "string" || !/^voice-[a-f0-9]{8}$/i.test(handle)) {
    throw new TypeError("handle must be a voice- prefixed 8-hex task handle");
  }
  return `Starting that now. Task handle ${handle}.`;
}

export async function splitAtThreshold(workPromise, thresholdMs) {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new TypeError("thresholdMs must be a non-negative finite number");
  }

  const settled = Promise.resolve(workPromise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

  let timer;
  const threshold = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ threshold: true }), thresholdMs);
  });

  const winner = await Promise.race([settled, threshold]);
  if (!winner.threshold) {
    clearTimeout(timer);
    if (!winner.ok) throw winner.error;
    return { background: false, value: winner.value, continuation: null };
  }

  const continuation = settled.then((outcome) => {
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
  return { background: true, value: null, continuation };
}
