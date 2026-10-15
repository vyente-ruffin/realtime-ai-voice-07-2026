// Fix 5 pass/fail rules for one pause run (docs/VOICE-FIX-PLAN.md 5a-5c), kept apart from the
// live script so tests/live can check the rules without a browser or Azure.
// GPT-Live stamps fragments on a 200 ms audio-clock grid (start_ms/end_ms), so an answer that
// begins the moment V's last word ends can share that word's slot. "After V finishes" therefore
// means: not in an earlier slot than V's last word (start_ms >= its start_ms) and received after
// it (at > its at). The strict end_ms reading is reported too (strictAfter).
const GAP_MS = 1500; // the WAV's real silence between "uh" and "what"

/** Judge one 5a-5c run. `offsets` are the WAV parts' [start, end] seconds (part 2 is the gap). */
export function judge(frags, jobs, offsets = [[0, 1.2], [1.2, 2.7], [2.7, 3.8]]) {
  const user = frags.filter((f) => f.role === "user");
  const assistant = frags.filter((f) => f.role === "assistant");
  // The second part starts at the "what" right before "time" (a misheard "So, what can you
  // check" must not move it); when the transcript lost that "what", at "time".
  const time = user.find((f) => /\btime\b/i.test(f.text));
  const what = time && ([...user].reverse().find((f) => /\bwhat\b/i.test(f.text) && f.start_ms <= time.start_ms && f.start_ms >= time.start_ms - 600) || time);
  const before = what ? user.filter((f) => f.start_ms < what.start_ms) : [];
  // The pause runs from the last user word before "what" to "what". When the transcript lost the
  // words before "what", the pause is placed from the WAV: the 1.5 s right before "what".
  const pauseFromWav = Boolean(what) && !before.length;
  const pauseTo = what?.start_ms ?? null;
  const pauseFrom = what ? (pauseFromWav ? pauseTo - GAP_MS : Math.max(...before.map((f) => f.end_ms))) : null;
  const speechStart = what ? (before.length ? Math.min(...before.map((f) => f.start_ms)) : pauseTo - offsets[2][0] * 1000) : null;
  const last = user.length ? user.reduce((a, b) => (b.end_ms > a.end_ms || (b.end_ms === a.end_ms && b.at > a.at) ? b : a)) : null;
  // On the 200 ms grid a reply to "uh" can share its slot; it is still in the pause when it was
  // received after that word (the same "after" rule as 5b uses for V's last word).
  const lastBefore = before.length ? before.reduce((a, b) => (b.end_ms > a.end_ms || (b.end_ms === a.end_ms && b.at > a.at) ? b : a)) : null;
  const inPause = what
    ? assistant.filter((f) => f.start_ms < pauseTo && (f.start_ms > pauseFrom || (lastBefore && f.start_ms >= lastBefore.start_ms && f.at > lastBefore.at)))
    : [];
  // Assistant speech after V began talking, grouped into turns (a turn ends at a 1.8 s gap, as in harness.turns).
  const answers = [];
  for (const f of assistant.filter((a) => speechStart !== null && a.start_ms >= speechStart)) {
    const t = answers.at(-1);
    if (t && f.start_ms - t.end_ms < 1800) { t.text += f.text; t.end_ms = f.end_ms; }
    else answers.push({ text: f.text, start_ms: f.start_ms, end_ms: f.end_ms, at: f.at });
  }
  const isAfter = (f) => f.start_ms >= last.start_ms && f.at > last.at;
  const firstAfter = last ? assistant.find(isAfter) : null;
  const latency = firstAfter ? Math.max(0, firstAfter.start_ms - last.end_ms) : null;
  return {
    userText: user.map((f) => f.text).join(""),
    pauseFrom, pauseTo, pauseFromWav,
    lastUser: last && { text: last.text, start_ms: last.start_ms, end_ms: last.end_ms, at: last.at },
    assistantInPause: inPause,
    answers,
    assistantBeforeUserSpoke: assistant.filter((f) => speechStart === null || f.start_ms < speechStart).map((f) => f.text).join(""),
    jobs: jobs.length,
    latencyMs: latency,
    strictAfter: answers.length === 1 && answers[0].start_ms >= last.end_ms,
    pass5a: Boolean(what) && inPause.length === 0,
    pass5b: answers.length === 1 && isAfter(answers[0]) && jobs.length <= 1,
    pass5c: latency !== null && latency <= 3000,
  };
}
