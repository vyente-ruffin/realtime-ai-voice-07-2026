// Other-city time check (docs/evidence/clock-zones.md): does the spoken hour and minute match
// Intl for that city's IANA zone, within 1 minute? Kept apart from the live script so tests/live
// can check the rules without a browser or Azure.

const UNITS = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b([ap])\.\s?m\b\.?/g, "$1m")
    .replace(/(\d)([ap]m)\b/g, "$1 $2")
    // Fragments " 3" + "40" join without a colon: "340 am" can only be 3:40 am.
    .replace(/\b(\d{1,2})(\d{2}) ([ap]m)\b/g, "$1:$2 $3")
    .replace(/([a-z])(\d)/g, "$1 $2") // fragments join without a space: "Kolkata10:11"
    .replace(/[-–—]/g, " ")
    .replace(/[^a-z0-9: ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/** A number 0-59 spoken from tokens[i]: digits, "six", "thirty six", "oh six". Returns [value, tokensUsed]. */
function number(tokens, i) {
  const t = tokens[i];
  if (t === undefined) return null;
  if (/^\d{1,2}$/.test(t)) return [Number(t), 1];
  if (t in TENS) {
    const u = UNITS[tokens[i + 1]];
    return u >= 1 && u <= 9 ? [TENS[t] + u, 2] : [TENS[t], 1];
  }
  if ((t === "oh" || t === "o") && UNITS[tokens[i + 1]] >= 1 && UNITS[tokens[i + 1]] <= 9) return [UNITS[tokens[i + 1]], 2];
  if (t in UNITS && t !== "oh" && t !== "o") return [UNITS[t], 1];
  return null;
}
/** am/pm said after a time: "pm", "in the afternoon", "at night". Returns [half or null, tokensUsed]. */
function meridiem(tokens, i) {
  const t = tokens[i], next = tokens.slice(i, i + 3).join(" ");
  if (t === "am") return ["am", 1];
  if (t === "pm") return ["pm", 1];
  if (/^in the morning/.test(next)) return ["am", 3];
  if (/^in the (afternoon|evening)/.test(next)) return ["pm", 3];
  if (/^at night/.test(next)) return ["pm", 2];
  return [null, 0];
}
const toMinutes = (h, m, half) => {
  if (half === "am") return (h % 12) * 60 + m;
  if (half === "pm") return ((h % 12) + 12) * 60 + m;
  return h * 60 + m; // no am/pm said: compared on a 12-hour dial
};

/** Every clock time said in `text`: [{ minutes (of day, or of a 12 h dial when !half), half, said }]. */
export function spokenTimes(text) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // "noon", "midnight"
    if (t === "noon" || t === "midday") { found.push({ minutes: 720, half: "pm", said: t }); continue; }
    if (t === "midnight") { found.push({ minutes: 0, half: "am", said: t }); continue; }
    // "1:06", "13:06", "1:06 pm"
    const colon = t.match(/^(\d{1,2}):(\d{2})$/);
    if (colon) {
      const [half, used] = meridiem(tokens, i + 1);
      const h = Number(colon[1]), m = Number(colon[2]);
      found.push({ minutes: toMinutes(h, m, h > 12 ? null : half), half: h > 12 ? "24h" : half, said: tokens.slice(i, i + 1 + used).join(" ") });
      i += used;
      continue;
    }
    // "half past nine", "quarter to ten", "six minutes past one", "twenty to two"
    const rel = (() => {
      let j = i, m;
      if (t === "half") m = 30, j++;
      else if (t === "quarter") m = 15, j++;
      else {
        const n = number(tokens, i);
        if (!n) return null;
        m = n[0], j += n[1];
        if (tokens[j] === "minutes" || tokens[j] === "minute") j++;
      }
      const dir = tokens[j];
      if (!["past", "after", "to", "till", "before"].includes(dir)) return null;
      const h = number(tokens, j + 1);
      if (!h || h[0] < 1 || h[0] > 12) return null;
      const [half, used] = meridiem(tokens, j + 1 + h[1]);
      const hour = ["to", "till", "before"].includes(dir) ? h[0] - 1 : h[0];
      const minute = ["to", "till", "before"].includes(dir) ? 60 - m : m;
      const end = j + 1 + h[1] + used;
      return { time: { minutes: toMinutes(hour === 0 ? 12 : hour, minute, half), half, said: tokens.slice(i, end).join(" ") }, end };
    })();
    if (rel) { found.push(rel.time); i = rel.end - 1; continue; }
    // "1 pm", "two oh six pm", "nine thirty six", "one oclock"
    const h = number(tokens, i);
    if (!h || h[0] < 1 || h[0] > 12) continue;
    let j = i + h[1], m = 0, minuteSaid = false;
    if (tokens[j] === "oclock") j++, minuteSaid = true;
    else {
      const n = number(tokens, j);
      // "one oh six" / "nine thirty six" / "1 06"; a bare unit after the hour ("two six") is not a time.
      if (n && n[0] <= 59 && (n[1] === 2 || n[0] >= 10 || /^\d{2}$/.test(tokens[j]))) m = n[0], j += n[1], minuteSaid = true;
    }
    const [half, used] = meridiem(tokens, j);
    if (!minuteSaid && !half) continue; // "one short sentence" is not a time
    found.push({ minutes: toMinutes(h[0], m, half), half, said: tokens.slice(i, j + used).join(" ") });
    i = j + used - 1;
  }
  return found;
}

/** Intl's time for `zone` at instant `at` (ms): minutes of the day, 0-1439, and the weekday. */
export function zoneTime(zone, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", weekday: "long",
  }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday: parts.weekday, text: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(at)) };
}

/** Minutes between a spoken time and the expected one; no am/pm said compares on a 12 h dial. */
export function minutesOff(spoken, expectedMinutes) {
  const dial = spoken.half === "am" || spoken.half === "pm" || spoken.half === "24h" ? 1440 : 720;
  const d = Math.abs(spoken.minutes % dial - expectedMinutes % dial) % dial;
  return Math.min(d, dial - d);
}

/**
 * Judge one call. The answer is the assistant speech after the user's first words; its first
 * spoken time is compared with Intl for `zone` at the answer's first fragment (state.sqlite `at`).
 */
export function judgeZone(frags, jobs, zone) {
  const user = frags.filter((f) => f.role === "user");
  const firstUser = user[0] || null;
  const answer = frags.filter((f) => f.role === "assistant" && firstUser && (f.at > firstUser.at || f.start_ms >= firstUser.start_ms));
  const text = answer.map((f) => f.text).join("");
  const times = spokenTimes(text);
  const at = answer[0]?.at ?? null;
  const expected = at === null ? null : zoneTime(zone, at);
  const spoken = times[0] || null;
  const off = spoken && expected ? minutesOff(spoken, expected.minutes) : null;
  const pass = off !== null && off <= 1 && jobs.length === 0;
  return {
    zone, userText: user.map((f) => f.text).join(""), answer: text, answerAt: at,
    expected: expected?.text ?? null, spoken: spoken?.said ?? null, spokenHalf: spoken?.half ?? null,
    minutesOff: off, jobs: jobs.length, pass,
  };
}
