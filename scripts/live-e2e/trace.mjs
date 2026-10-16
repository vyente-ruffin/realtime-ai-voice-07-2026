// Print one voice call's whole flow in time order from the logs alone, then check it for gaps.
//   node scripts/live-e2e/trace.mjs <callId> [--json]
// Sources (all read-only): the app's audit log, transcript fragments, jobs and deliveries in
// ~/.local/state/jarvis-voice/state.sqlite, and Hermes's ~/.hermes/logs/agent.log for each run id.
// Every line is one structured record with one timestamp format (ISO 8601 UTC), its source and
// its correlation ids (call, session, delegation, job, run, event): MS Learn, "Best
// practices for monitoring and diagnostics", "Instrument an application". Content text is never
// printed for model sends (only purpose and length); transcripts are the call's own words.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "./harness.mjs";

// Rows the server writes itself; every other audit row was sent by the page.
const SERVER = new Set(["session.started", "session.cut_off", "delivery.offered", "delivery.offer_refused", "delivery.injected",
  "delivery.ack_ignored", "delivery.released", "result.playback_observed"]);
const iso = (ms) => new Date(ms).toISOString();
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/** Hermes agent.log lines for a run id and its Hermes session, with content redacted. */
export function hermesLines(run, hermesSession, from, to) {
  const dir = resolve(process.env.HOME, ".hermes/logs");
  const out = [];
  for (const name of ["agent.log", "agent.log.1"]) {
    const file = resolve(dir, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(run) && !(hermesSession && line.includes(`[${hermesSession}]`))) continue;
      const m = line.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),(\d{3}) (\w+) (.*)$/);
      if (!m) continue;
      const at = Date.parse(`${m[1]}T${m[2]}.${m[3]}Z`); // agent.log is UTC (its access lines say +0000)
      if (at < from - 60000 || at > to + 600000) continue;
      // Requests and replies can hold personal text: keep the logger and its ids, drop msg='…'.
      const text = m[5].replace(/msg='.*$/, "msg=<redacted>").replace(/\[voice-[^\]]+\] /, "").slice(0, 220);
      out.push({ at, run, matched: line.includes(run) ? "run_id" : "hermes_session", text });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Fragments joined into turns per speaker (a gap of 1.8 s on the audio clock starts a new turn). */
function turns(session) {
  const out = [];
  const open = {};
  for (const r of query("SELECT role,text,at,start_ms,end_ms FROM fragments WHERE session=? ORDER BY at,rowid", session)) {
    const last = open[r.role];
    if (last && r.start_ms - last.end_ms < 1800) {
      last.text += r.text;
      last.end_ms = r.end_ms;
    } else out.push((open[r.role] = { role: r.role, text: r.text, at: r.at, start_ms: r.start_ms, end_ms: r.end_ms }));
  }
  return out;
}

export function trace(callId) {
  const started = query("SELECT conversation,payload,at FROM audit WHERE kind='session.started' AND json_extract(payload,'$.callId')=?", callId);
  const any = query("SELECT conversation FROM audit WHERE json_extract(payload,'$.callId')=? LIMIT 1", callId)[0];
  if (!any) throw new Error(`No audit rows for call ${callId}`);
  const conversation = any.conversation;
  const sessions = [...new Set(started.map((r) => parse(r.payload).session))];
  const rows = query("SELECT id,kind,payload,at FROM audit WHERE conversation=? ORDER BY id", conversation).map((r) => ({ ...r, p: parse(r.payload) }));
  const mine = rows.filter((r) => r.p.callId === callId || sessions.includes(r.p.session));
  const from = Math.min(...mine.map((r) => r.at)), to = Math.max(...mine.map((r) => r.at));
  // Jobs this call made or delivered, and every job row in the audit log for them.
  const jobIds = new Set(mine.filter((r) => r.p.job).map((r) => r.p.job));
  const jobs = query(`SELECT id,delegation,session,state,run_id,hermes_session,created,updated FROM jobs WHERE conversation=?`, conversation)
    .filter((j) => sessions.includes(j.session) || jobIds.has(j.id));
  for (const j of jobs) jobIds.add(j.id);
  const jobRows = rows.filter((r) => r.kind.startsWith("job.") && jobIds.has(r.p.job) && !mine.includes(r));
  const lines = [];
  const add = (at, source, step, text, ids = {}) => lines.push({ at, source, step, text, ids });
  for (const r of [...mine, ...jobRows]) {
    const p = r.p, d = p.detail || {};
    const at = p.ts || r.at;
    const ids = Object.fromEntries(Object.entries({ call: p.callId, session: p.session, delegation: p.delegation || d.delegationId, job: p.job, run: p.run, event: p.event || d.eventId }).filter(([, v]) => v));
    let step = r.kind, text = "";
    if (r.kind === "model.send") text = `${d.eventType} purpose=${d.purpose} length=${d.contentLength}`;
    else if (r.kind === "model.ack") text = `${d.eventType} purpose=${d.purpose} ackMs=${d.ackMs}`;
    else if (r.kind === "model.rejected") text = `purpose=${d.purpose}`;
    else if (r.kind.startsWith("job.")) text = `state=${p.state}${p.run ? ` run=${p.run}` : ""}${p.hermesSession ? ` hermesSession=${p.hermesSession}` : ""}`;
    else if (r.kind === "connection.microphone") text = `microphone=${d.microphoneState}`;
    else if (r.kind === "connection.playback") text = `playback=${d.playbackState}`;
    else if (r.kind === "connection.audio_context") text = `audioContext=${d.audioContextState}`;
    else if (r.kind === "connection.state") text = `connection=${d.connectionState}`;
    else if (r.kind === "session.started") text = `connectionMs=${p.connectionMs} providerRequestId=${p.providerRequestId}`;
    else if (r.kind === "call.ended" || r.kind === "connection.ending") text = `reason=${d.reason}`;
    else if (r.kind === "call.stats") continue; // periodic quality samples; counted below, not listed
    add(at, SERVER.has(r.kind) || r.kind.startsWith("job.") ? "server" : "browser", step, text, ids);
  }
  for (const s of sessions) for (const t of turns(s)) add(t.at, "transcript", `turn.${t.role}`, JSON.stringify(t.text.trim()), { session: s, audioMs: `${t.start_ms}-${t.end_ms}` });
  const hermes = [];
  for (const j of jobs.filter((j) => j.run_id)) for (const h of hermesLines(j.run_id, j.hermes_session, j.created, Math.max(j.updated, to))) {
    hermes.push(h);
    add(h.at, "hermes", "hermes.log", `${h.text}`, { run: h.run, job: j.id, matched: h.matched });
  }
  lines.sort((a, b) => a.at - b.at || a.step.localeCompare(b.step));
  return { callId, conversation, sessions, jobs, lines, stats: mine.filter((r) => r.kind === "call.stats").length, hermes };
}

/** The flow the plan names, each step with the record that proves it, and gaps where a step
 * happened (by another record) without its own record. */
export function check(t) {
  const has = (step, pred = () => true) => t.lines.filter((l) => l.step === step && pred(l));
  const sends = has("model.send"), acks = has("model.ack"), rejects = has("model.rejected");
  const result = sends.filter((l) => /purpose=result/.test(l.text));
  const steps = {
    "connection started": has("connection.started"),
    "microphone live": has("connection.microphone", (l) => /live/.test(l.text)),
    "session started": has("session.started"),
    "user turn": has("turn.user"),
    "assistant turn": has("turn.assistant"),
    "model send": sends,
    "model ack": acks,
    "delegation received": has("delegation.received"),
    "job queued": has("job.queued"),
    "hermes run started": has("job.run_started", (l) => l.ids.run),
    "hermes agent.log line": has("hermes.log", (l) => l.ids.matched === "run_id"),
    "job completed": has("job.state", (l) => /state=completed/.test(l.text)),
    "result offered": has("delivery.offered"),
    "result sent to model": result,
    "result injected": has("delivery.injected"),
    "playback": has("connection.playback"),
    "result playback observed": has("result.playback_observed"),
    stop: has("delivery.stop"),
    "call ended": has("call.ended"),
  };
  const missing = Object.entries(steps).filter(([, v]) => !v.length).map(([k]) => k);
  const gaps = [];
  for (const s of sends) if (!acks.some((a) => a.ids.event === s.ids.event) && !rejects.some((a) => a.ids.event === s.ids.event)) gaps.push(`send ${s.ids.event} has no ack or rejection`);
  for (const a of acks) if (!sends.some((s) => s.ids.event === a.ids.event)) gaps.push(`ack ${a.ids.event} has no send`);
  for (const d of has("delegation.received")) if (!has("job.queued", (q) => q.ids.delegation === d.ids.delegation).length && !has("delegation.cut_off_reply", (q) => q.ids.delegation === d.ids.delegation).length && !has("delegation.consent_reply", (q) => q.ids.delegation === d.ids.delegation).length && !has("delegation.consent_reply_untranscribed", (q) => q.ids.delegation === d.ids.delegation).length) gaps.push(`delegation ${d.ids.delegation} has no job or reply record`);
  for (const j of t.jobs) {
    if (!has("job.queued", (l) => l.ids.job === j.id).length) gaps.push(`job ${j.id} has no job.queued row`);
    if (j.run_id && !has("job.run_started", (l) => l.ids.run === j.run_id).length) gaps.push(`job ${j.id} run ${j.run_id} has no job.run_started row`);
    if (j.run_id && !has("hermes.log", (l) => l.ids.run === j.run_id && l.ids.matched === "run_id").length) gaps.push(`run ${j.run_id} has no agent.log line`);
    if (!has("job.state", (l) => l.ids.job === j.id && l.text.includes(`state=${j.state}`)).length) gaps.push(`job ${j.id} final state ${j.state} has no job.state row`);
  }
  for (const o of has("delivery.offered")) {
    if (!result.some((s) => s.ids.event?.startsWith(o.ids.event))) gaps.push(`offer ${o.ids.event} has no result send`);
    if (!has("delivery.injected", (l) => l.ids.event === o.ids.event).length && !has("delivery.released", (l) => l.ids.event === o.ids.event).length) gaps.push(`offer ${o.ids.event} has no injected/released row`);
  }
  for (const s of result) if (!has("delivery.offered", (o) => s.ids.event?.startsWith(o.ids.event)).length) gaps.push(`result send ${s.ids.event} has no delivery offer`);
  return { steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.length])), missing, gaps, pass: !missing.length && !gaps.length };
}

export function print(t, c) {
  console.log(`call ${t.callId}  conversation ${t.conversation}  sessions ${t.sessions.join(",")}  (call.stats samples: ${t.stats})`);
  for (const l of t.lines) {
    const ids = Object.entries(l.ids).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${iso(l.at)}  ${l.source.padEnd(10)} ${l.step.padEnd(26)} ${l.text}${ids ? `  [${ids}]` : ""}`);
  }
  console.log(`\nSTEPS ${JSON.stringify(c.steps)}`);
  console.log(`MISSING ${JSON.stringify(c.missing)}`);
  console.log(`GAPS ${JSON.stringify(c.gaps)}`);
  console.log(`TRACE ${c.pass ? "PASS" : "FAIL"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [callId, flag] = process.argv.slice(2);
  if (!callId) {
    console.error("usage: node scripts/live-e2e/trace.mjs <callId> [--json]");
    process.exit(2);
  }
  const t = trace(callId);
  const c = check(t);
  if (flag === "--json") console.log(JSON.stringify({ ...t, check: c }, null, 1));
  else print(t, c);
  process.exit(c.pass ? 0 : 1);
}
