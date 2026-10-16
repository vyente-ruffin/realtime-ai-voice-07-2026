// Part 2 counter: how many times one job's result was spoken and sent in one session, measured
// from state.sqlite (fragments, audit, jobs). Kept apart from double-read.mjs so a stored call
// can be re-measured without starting a run:
//   node scripts/live-e2e/double-read-judge.mjs <jobId> <session> [sinceMs]
import { query, turns } from "./harness.mjs";

// Diacritics are folded first: Hermes wrote "kākāpō", the voice said "kakapo" (same bird).
export const norm = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** How many times the result was spoken and sent, measured from the database. */
export function measure(jobId, session, since) {
  const job = query("SELECT id,result FROM jobs WHERE id=?", jobId)[0];
  const key = norm(job.result.match(/ is ([^.]+)\./)?.[1] || "\u0000");
  const assistant = turns(session).filter((t) => t.role === "assistant" && t.at >= since);
  const spokenRuns = assistant.filter((t) => norm(t.text).includes(key));
  const said = norm(assistant.map((t) => t.text).join(" "));
  const occurrences = said.split(key).length - 1;
  // Any statement of the result's shape counts, so a made-up version before the real one fails.
  const subject = norm(job.result.split(/ is /)[0]);
  const statements = said.split(`${subject} is `).length - 1;
  const statementRuns = assistant.filter((t) => norm(t.text).includes(`${subject} is `)).length;
  const offers = query("SELECT json_extract(payload,'$.event') AS event FROM audit WHERE kind='delivery.offered' AND json_extract(payload,'$.job')=?", jobId).map((r) => r.event);
  const sends = query("SELECT json_extract(payload,'$.detail.eventId') AS id, json_extract(payload,'$.detail.eventType') AS type, json_extract(payload,'$.session') AS session FROM audit WHERE kind='model.send' AND json_extract(payload,'$.detail.purpose')='result'")
    .filter((r) => offers.some((o) => r.id?.startsWith(o)));
  const rerun = query("SELECT id,delegation,created FROM jobs WHERE session=? AND id<>?", session, jobId);
  const replies = query("SELECT kind,payload,at FROM audit WHERE kind IN ('delegation.consent_reply','delegation.consent_reply_untranscribed','delegation.received') AND json_extract(payload,'$.session')=?", session);
  return {
    key, subject, spokenRuns: spokenRuns.length, occurrences, statements, statementRuns, commentarySends: sends.filter((s) => s.type === "session.commentary.append").length,
    offers: offers.length, rerunJobs: rerun.length, delegations: replies.map((r) => r.kind),
    transcript: turns(session).map((t) => `${t.role}: ${t.text.trim()}`),
    pass: spokenRuns.length === 1 && occurrences === 1 && statements === 1 && statementRuns === 1 && sends.length === 1 && rerun.length === 0,
  };
}


if (import.meta.url === `file://${process.argv[1]}`) {
  const [job, session, since = "0"] = process.argv.slice(2);
  const r = measure(job, session, Number(since));
  console.log(JSON.stringify({ ...r, transcript: undefined }));
  for (const line of r.transcript) console.log(`  ${line}`);
  process.exit(r.pass ? 0 : 1);
}
