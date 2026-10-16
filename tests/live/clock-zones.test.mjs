/** Other-city times: the app works them out with Intl for the IANA zone and supplies them as quiet
 * context, so the voice never does offset arithmetic (it said Tokyo was "two-oh-six PM" at 1:06 PM). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clockSnapshot, namedZones, namedPlacesContext, placeTime, worldClock, WORLD_CITIES } from "../../web/clock-context.js";
import { spokenTimes, minutesOff, judgeZone, zoneTime } from "../../scripts/live-e2e/clock-zones-judge.mjs";
import * as policy from "../../src/live/policy.js";

// The failing call: 2026-10-16 04:06 UTC, browser in Los Angeles (Pacific Daylight Time).
const failing = new Date("2026-10-16T04:06:07.119Z");

test("the world list carries each city's time from Intl, including half-hour, 45-minute and date-line zones", () => {
  const list = worldClock(failing);
  for (const entry of [
    "Tokyo, Seoul Fri 1:06 PM", // not 2:06 PM: Pacific is daylight time, 16 hours behind, not 17
    "London Fri 5:06 AM", // British Summer Time
    "Sydney, Melbourne Fri 3:06 PM", // Australian daylight time since Oct 4
    "India Fri 9:36 AM", // UTC+5:30
    "Kathmandu Fri 9:51 AM", // UTC+5:45
    "New York Fri 12:06 AM",
    "Honolulu Thu 6:06 PM",
    "Auckland Fri 5:06 PM",
  ]) assert.ok(list.includes(`${entry};`) || list.includes(`${entry}.`), entry);
  assert.match(list, /never add offsets yourself/);
  assert.equal(placeTime("Australia/Adelaide", failing, "short"), "Fri 2:36 PM"); // UTC+10:30
  assert.equal(placeTime("America/St_Johns", failing, "short"), "Fri 1:36 AM"); // UTC-2:30
});

test("every clock update carries the world list and stays within two appends", () => {
  // The voice answers in the same slot as the city name, before a per-place update can land (seen live).
  const context = clockSnapshot(failing, "America/Los_Angeles").context;
  assert.match(context, /Thursday, October 15, 2026 at 9:06 PM, Pacific Daylight Time, zone America\/Los_Angeles, 04:06 UTC/);
  assert.ok(context.includes(worldClock(failing)));
  assert.ok(Buffer.byteLength(context) <= 960, `${Buffer.byteLength(context)} bytes`);
});

test("across the date line: Auckland is already tomorrow while Los Angeles and Honolulu are today", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  assert.equal(placeTime("America/Los_Angeles", now, "short"), "Fri 5:00 AM");
  assert.equal(placeTime("Pacific/Auckland", now, "short"), "Sat 1:00 AM");
  assert.equal(placeTime("Pacific/Honolulu", now, "short"), "Fri 2:00 AM");
  assert.equal(placeTime("Pacific/Auckland", now), "Saturday, October 17 at 1:00 AM");
  assert.match(worldClock(now), /Auckland Sat 1:00 AM\./);
});

test("daylight-saving changes come from Intl, not a fixed offset", () => {
  // London leaves summer time on Oct 25, 2026; Sydney entered daylight time on Oct 4, 2026.
  assert.equal(placeTime("Europe/London", new Date("2026-10-24T12:00:00Z"), "short"), "Sat 1:00 PM");
  assert.equal(placeTime("Europe/London", new Date("2026-10-26T12:00:00Z"), "short"), "Mon 12:00 PM");
  assert.equal(placeTime("Australia/Sydney", new Date("2026-10-03T12:00:00Z"), "short"), "Sat 10:00 PM");
  assert.equal(placeTime("Australia/Sydney", new Date("2026-10-05T12:00:00Z"), "short"), "Mon 11:00 PM");
});

test("spoken place names resolve to IANA zones, including names the zone IDs don't carry", () => {
  const zone = (s) => namedZones(s).map((x) => x.zone);
  assert.deepEqual(zone("What time is it in Tokyo?"), ["Asia/Tokyo"]);
  assert.deepEqual(zone("what time is it in Kolkata"), ["Asia/Kolkata"]);
  assert.deepEqual(zone("and in Mumbai?"), ["Asia/Kolkata"]);
  assert.deepEqual(zone("What time is it in New York right now"), ["America/New_York"]);
  assert.deepEqual(zone("time in São Paulo"), ["America/Sao_Paulo"]);
  assert.deepEqual(zone("Washington, D.C."), ["America/New_York"]);
  assert.deepEqual(zone("Kathmandu"), ["Asia/Kathmandu"]);
  assert.deepEqual(zone("Ho Chi Minh City"), ["Asia/Ho_Chi_Minh"]);
  assert.deepEqual(zone("Tokyo and London"), ["Asia/Tokyo", "Europe/London"]);
  assert.deepEqual(zone("what time is it on Christmas"), [], "ordinary words that end an IANA ID are not places");
  assert.deepEqual(zone("what time is it"), []);
  for (const [, id] of WORLD_CITIES) assert.doesNotThrow(() => placeTime(id, failing), id);
});

test("a named place gets its own quiet context with the full date and time from Intl", () => {
  const context = namedPlacesContext("what time is it in Kathmandu", failing);
  assert.match(context, /Kathmandu \(Asia\/Kathmandu\): Friday, October 16 at 9:51 AM/);
  assert.match(context, /never work it out from the local time or a time-zone offset/);
  assert.equal(namedPlacesContext("what time is it", failing), "");
});

test("the page sends a named place's time during the turn and in a clock handoff reply, never a Hermes job", () => {
  const live = readFileSync(new URL("../../web/live.js", import.meta.url), "utf8");
  assert.match(live, /function placeTimes\(text\) \{\n\s*if \(!text \|\| !clockQuestion\(text\)\) return;/);
  assert.match(live, /append\("session\.thinking\.append", namedPlacesContext\([^\n]*"clock"\);/);
  assert.match(live, /\n(?:\s*\/\/.*\n)*\s*placeTimes\(turnTaking\.turn\?\.text\);/);
  const delegate = live.slice(live.indexOf("async function delegate(event)"), live.indexOf("async function handle("));
  assert.match(delegate, /\$\{namedPlacesContext\(said\)\} \$\{clockSnapshot\(\)\.context\}/);
  assert.ok(delegate.indexOf("clockQuestion(said)") < delegate.indexOf('api("/api/delegations"'));
});

test("the speech instructions no longer ask the voice to add a UTC offset itself", () => {
  const voice = policy.instructions("", [], { timeZone: "America/Los_Angeles" });
  assert.doesNotMatch(voice, /add that city's UTC offset/);
  assert.match(voice, /say the time the app's clock context gives for that place, exactly; never work it out from the local time or a time-zone offset/);
});

test("judge: spoken clock times in the forms the voice uses", () => {
  const first = (s) => spokenTimes(s)[0];
  assert.deepEqual([first(" It's 1:06 PM on Friday in Tokyo.").minutes, first(" It's 1:06 PM on Friday in Tokyo.").half], [13 * 60 + 6, "pm"]);
  assert.equal(first(" Okay, it's two-oh-six PM Friday in Tokyo, Japan time.").minutes, 14 * 60 + 6);
  assert.equal(first(" Two-oh-seven PM on Friday in Tokyo.").minutes, 14 * 60 + 7);
  assert.equal(first("Hmm... It's 1 PM on Friday in Tokyo.").minutes, 13 * 60);
  assert.equal(first(" It's 1:09 in the afternoon in Tokyo, Japan time.").minutes, 13 * 60 + 9);
  assert.equal(first(" It’s 3:26 in the morning in Tokyo").minutes, 3 * 60 + 26);
  assert.equal(first("It's 12:06 a.m. in New York").minutes, 6);
  assert.equal(first("It's nine thirty-six AM in Kolkata").minutes, 9 * 60 + 36);
  assert.equal(first("It's half past nine in the morning").minutes, 9 * 60 + 30);
  assert.equal(first("about twenty to ten pm").minutes, 21 * 60 + 40);
  assert.equal(first("It's noon in London").minutes, 720);
  assert.equal(first("It's 17:06 in London").minutes, 17 * 60 + 6);
  assert.equal(first("It's 5:06 in London").half, null);
  assert.equal(spokenTimes("Answer in one short sentence").length, 0);
  assert.equal(first(" time in Kolkata10:11 AM.").minutes, 10 * 60 + 11, "fragments joined without a space (seen live)");
});

test("judge: within 1 minute of Intl for the zone passes; the recorded wrong hour fails", () => {
  const at = Date.parse("2026-10-16T04:06:11.169Z");
  assert.equal(zoneTime("Asia/Tokyo", at).text, "Fri 1:06 PM");
  assert.equal(minutesOff(spokenTimes("1:07 PM")[0], zoneTime("Asia/Tokyo", at).minutes), 1);
  assert.equal(minutesOff(spokenTimes("1:06")[0], zoneTime("Asia/Tokyo", at).minutes), 0, "no am/pm: 12-hour dial");
  const frags = [
    { role: "user", text: " What time is it in Tokyo?", at: at - 400, start_ms: 3800 },
    { role: "assistant", text: " Okay, it's two-oh-six PM Friday in Tokyo, Japan time.", at, start_ms: 5000 },
  ];
  const wrong = judgeZone(frags, [], "Asia/Tokyo");
  assert.equal(wrong.minutesOff, 60);
  assert.equal(wrong.pass, false);
  frags[1].text = " It's 1:06 PM on Friday in Tokyo.";
  assert.equal(judgeZone(frags, [], "Asia/Tokyo").pass, true);
  assert.equal(judgeZone(frags, [{ id: "job" }], "Asia/Tokyo").pass, false, "a Hermes job for a time question fails");
  frags[1].text = " Let me check that for you.";
  assert.equal(judgeZone(frags, [], "Asia/Tokyo").pass, false, "no spoken time is not a pass");
});

test("the session prompt carries the world-city times from the call's start", async () => {
  const { worldTimes } = await import("../../web/clock-context.js");
  const now = new Date("2026-10-16T20:00:00Z");
  const voice = policy.instructions("", [], { timeZone: "America/Los_Angeles" });
  assert.match(voice, /Reference only for when the user asks another place's time, never to mention otherwise: at this prompt's creation the app worked out [^\n]*Tokyo/);
  assert.ok(policy.localTimeContext({ timeZone: "America/Los_Angeles", now, browserClock: true }).includes(`the app worked out ${worldTimes(now, false)}.`));
  assert.ok(worldTimes(now, false).includes("Paris Fri 10:00 PM; Berlin Fri 10:00 PM"), "each city next to its own time");
  assert.doesNotMatch(policy.localTimeContext({ timeZone: "America/Los_Angeles", now }), /the app worked out/, "not in Hermes's worker prompt");
});

test("judge: fragments ' 3' + '40' joined as '340 a.m.' read as 3:40 am", async () => {
  const { spokenTimes } = await import("../../scripts/live-e2e/clock-zones-judge.mjs");
  assert.equal(spokenTimes(" It’s 340 a.m. Saturday, in Kathmandu.")[0]?.minutes, 220);
  assert.equal(spokenTimes(" It's 1140 PM in London.")[0]?.minutes, 23 * 60 + 40);
  assert.equal(spokenTimes(" The server has 340 GB free.").length, 0, "not without am/pm");
});
