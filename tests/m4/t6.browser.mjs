// M4.T6 — browser proof that barge-in drops queued speech.
//
// Loads the real talk.html served by talk-server.js in Chromium and drives the
// exact defect sequence in page scope: a reply is queued while the mouth is
// busy, the user interrupts, and the next response.done flush must speak
// nothing. Before the fix, the queued reply survived and was spoken one
// question behind.
import { chromium } from "playwright";

const baseUrl = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
let fail = 0;
const ok = (n, m) => console.log(`  PASS m4.t6.${n}: ${m}`);
const bad = (n, m) => { console.log(`  FAIL m4.t6.${n}: ${m}`); fail = 1; };

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/?synthetic=1`);
  await page.waitForFunction(() => typeof window.handleEvent === "function");

  const result = await page.evaluate(() => {
    // Reproduce the pre-interrupt state: an answer already broadcast by the
    // server, deferred at the mouth because a filler is still playing.
    speakQueue.length = 0;
    speakQueue.push("answer to the previous question");
    const queuedBefore = speakQueue.length;

    // The user interrupts.
    handleEvent({ type: "input_audio_buffer.speech_started" });
    const queuedAfterBargeIn = speakQueue.length;

    // The in-flight utterance ends; this is where the stale answer used to be
    // resurrected.
    handleEvent({ type: "response.done" });

    return {
      queuedBefore,
      queuedAfterBargeIn,
      queuedAfterFlush: speakQueue.length,
      dropEvents: window.__voiceLabEvents.filter((e) => e.type === "speak.dropped"),
    };
  });

  result.queuedBefore === 1
    ? ok(1, "a reply was queued at the mouth before the interrupt")
    : bad(1, `expected 1 queued reply, saw ${result.queuedBefore}`);

  result.queuedAfterBargeIn === 0
    ? ok(2, "barge-in cleared the queued reply")
    : bad(2, `${result.queuedAfterBargeIn} stale replies survived barge-in`);

  result.queuedAfterFlush === 0
    ? ok(3, "the post-interrupt flush spoke nothing stale")
    : bad(3, `flush resurrected ${result.queuedAfterFlush} stale replies`);

  result.dropEvents.length === 1 && result.dropEvents[0].count === 1
    ? ok(4, "the drop is recorded in the page event log")
    : bad(4, `drop events: ${JSON.stringify(result.dropEvents)}`);
} finally {
  await browser.close();
}

process.exit(fail);
