// Fix 4: honest task status. One short line per running or recently ended task in this
// conversation: its name (from the user's request), state, minutes, newest Hermes progress
// step and, when it ended badly, the plain reason. Shared by the browser's quiet context
// and the server's session prompt so both describe a task the same way. Result text is
// never included: a result in context is a result read out unasked (Fix 1).
export const ACTIVE = ["queued", "running", "awaiting_permission"];
export const RECENT_MS = 30 * 60000;
const MAX_TASKS = 4;
const STATE_WORDS = {
  queued: "waiting to start",
  running: "running",
  awaiting_permission: "waiting for your approval",
  completed: "finished",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "stopped part way",
};
// Raw error wording never reaches speech, even from rows written before Fix 4.
const RAW = /internal error|glitch|the system ran into|exception|traceback|errno|\b[45]\d\d\b|[A-Za-z]+Error\b/i;
const clip = (text, max) => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
};
const minutes = (ms) => {
  const m = Math.floor(Math.max(0, ms) / 60000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
};

/** The task name: the user's own words from the request that started it. */
export function taskTitle(request) {
  const lines = String(request || "").split("\n");
  const said = lines.filter((l) => l.startsWith("user:")).at(-1)?.slice(5) ?? lines.at(-1);
  return clip(said, 80) || "a task";
}

/** A plain reason for a task that ended without a result, or null. */
export function plainReason(job) {
  if (!["failed", "cancelled", "interrupted"].includes(job.state)) return null;
  const error = clip(job.error, 200);
  if (error && !RAW.test(error)) return error;
  return job.state === "cancelled" ? "You cancelled it." : job.state === "interrupted" ? "It stopped part way and was not run again." : "Hermes could not finish it.";
}

export function statusLine(job, now) {
  const name = clip(job.title || taskTitle(job.request), 80);
  const parts = [`"${name}": ${STATE_WORDS[job.state] || job.state}`];
  if (ACTIVE.includes(job.state)) {
    parts.push(`started ${minutes(now - job.created)} ago`);
    if (job.progress) parts.push(`latest step: ${clip(job.progress, 140)}`);
    const ask = job.permissions?.[0]?.title;
    if (job.state === "awaiting_permission" && ask) parts.push(`needs your approval for: ${clip(ask, 100)}`);
  } else {
    parts.push(`ran ${minutes(job.updated - job.created)}, ended ${minutes(now - job.updated)} ago`);
    const reason = plainReason(job);
    if (reason) parts.push(`reason: ${reason}`);
  }
  return parts.join("; ");
}

/** Quiet status context: every running task, plus tasks that ended in the last 30 minutes. */
export function statusContext(jobs, now = Date.now()) {
  const shown = jobs
    .filter((j) => ACTIVE.includes(j.state) || now - j.updated < RECENT_MS)
    .sort((a, b) => b.created - a.created)
    .slice(0, MAX_TASKS);
  const running = jobs.filter((j) => ACTIVE.includes(j.state)).length;
  const head = running ? `${running === 1 ? "1 task is" : `${running} tasks are`} running now.` : "No task is running now.";
  const lines = shown.map((j) => `- ${statusLine(j, now)}`);
  return `Task status from the app (silent update, not a request to speak; use it only when the user asks about status): ${head}${lines.length ? `\n${lines.join("\n")}` : ""}`;
}

/** Fix 6: quiet confirmation of a memory save the app completed, naming what was saved. This is
 * the only thing that lets the voice say something is saved. */
export function saveConfirmation(saved) {
  const words = clip(String(saved || "").replace(/^User said:\s*/gm, ""), 300);
  return `Memory save confirmed by the app (silent update, not a request to speak): the user's own words "${words}" are now saved in long-term memory. Only an update like this proves a save. Do not announce it; if the user asks whether it is saved, say yes.`;
}
