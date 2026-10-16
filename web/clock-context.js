// Browser clock updates use the same acknowledged quiet-context path as memory.
import { MemoryContext } from "./memory-context.js";

// Other cities' times are worked out by the app with Intl for the IANA zone, never by the model:
// each clock update lists major cities' times, the page adds a named place's time as soon as the
// place is transcribed, and answers a handed-off time question with it.
// Seen live: given "9:06 PM Pacific Daylight Time", the voice said Tokyo was "two-oh-six PM" (it
// added the standard-time 17 hours, not 16). MS Learn, "What is GPT-Live": keep facts in the app
// and supply them as context; "Delegate work in GPT-Live": the application does the work.
// Spoken names the IANA zone IDs don't carry (the host's ICU also keeps old IDs such as
// Asia/Calcutta, so current names are listed here).
const PLACE_ZONES = {
  "kolkata": "Asia/Kolkata", "calcutta": "Asia/Kolkata", "mumbai": "Asia/Kolkata", "bombay": "Asia/Kolkata",
  "delhi": "Asia/Kolkata", "new delhi": "Asia/Kolkata", "bangalore": "Asia/Kolkata", "bengaluru": "Asia/Kolkata",
  "chennai": "Asia/Kolkata", "hyderabad": "Asia/Kolkata", "india": "Asia/Kolkata",
  "kathmandu": "Asia/Kathmandu", "nepal": "Asia/Kathmandu", "ho chi minh city": "Asia/Ho_Chi_Minh",
  "saigon": "Asia/Ho_Chi_Minh", "hanoi": "Asia/Bangkok", "vietnam": "Asia/Ho_Chi_Minh", "kyiv": "Europe/Kyiv",
  "kiev": "Europe/Kyiv", "ukraine": "Europe/Kyiv", "yangon": "Asia/Yangon", "myanmar": "Asia/Yangon",
  "beijing": "Asia/Shanghai", "china": "Asia/Shanghai", "japan": "Asia/Tokyo", "osaka": "Asia/Tokyo",
  "kyoto": "Asia/Tokyo", "korea": "Asia/Seoul", "south korea": "Asia/Seoul", "taiwan": "Asia/Taipei",
  "philippines": "Asia/Manila", "indonesia": "Asia/Jakarta", "thailand": "Asia/Bangkok", "pakistan": "Asia/Karachi",
  "islamabad": "Asia/Karachi", "lahore": "Asia/Karachi", "bangladesh": "Asia/Dhaka", "sri lanka": "Asia/Colombo",
  "uae": "Asia/Dubai", "abu dhabi": "Asia/Dubai", "israel": "Asia/Jerusalem", "tel aviv": "Asia/Jerusalem",
  "iran": "Asia/Tehran", "saudi arabia": "Asia/Riyadh", "turkey": "Europe/Istanbul", "russia": "Europe/Moscow",
  "uk": "Europe/London", "england": "Europe/London", "britain": "Europe/London", "united kingdom": "Europe/London",
  "scotland": "Europe/London", "edinburgh": "Europe/London", "manchester": "Europe/London", "ireland": "Europe/Dublin",
  "france": "Europe/Paris", "germany": "Europe/Berlin", "munich": "Europe/Berlin", "frankfurt": "Europe/Berlin",
  "italy": "Europe/Rome", "milan": "Europe/Rome", "spain": "Europe/Madrid", "barcelona": "Europe/Madrid",
  "portugal": "Europe/Lisbon", "netherlands": "Europe/Amsterdam", "belgium": "Europe/Brussels",
  "switzerland": "Europe/Zurich", "geneva": "Europe/Zurich", "sweden": "Europe/Stockholm", "norway": "Europe/Oslo",
  "denmark": "Europe/Copenhagen", "finland": "Europe/Helsinki", "poland": "Europe/Warsaw", "greece": "Europe/Athens",
  "egypt": "Africa/Cairo", "kenya": "Africa/Nairobi", "nigeria": "Africa/Lagos", "cape town": "Africa/Johannesburg",
  "south africa": "Africa/Johannesburg", "morocco": "Africa/Casablanca",
  "san francisco": "America/Los_Angeles", "seattle": "America/Los_Angeles", "las vegas": "America/Los_Angeles",
  "san diego": "America/Los_Angeles", "portland": "America/Los_Angeles", "california": "America/Los_Angeles",
  "washington dc": "America/New_York", "washington d c": "America/New_York", "boston": "America/New_York",
  "miami": "America/New_York", "atlanta": "America/New_York", "philadelphia": "America/New_York",
  "orlando": "America/New_York", "new jersey": "America/New_York", "dallas": "America/Chicago",
  "houston": "America/Chicago", "austin": "America/Chicago", "texas": "America/Chicago",
  "new orleans": "America/Chicago", "minneapolis": "America/Chicago", "salt lake city": "America/Denver",
  "hawaii": "Pacific/Honolulu", "alaska": "America/Anchorage", "montreal": "America/Toronto",
  "ottawa": "America/Toronto", "newfoundland": "America/St_Johns", "st johns": "America/St_Johns",
  "mexico": "America/Mexico_City", "brazil": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo",
  "rio": "America/Sao_Paulo", "argentina": "America/Argentina/Buenos_Aires", "chile": "America/Santiago",
  "peru": "America/Lima", "colombia": "America/Bogota", "new zealand": "Pacific/Auckland",
  "wellington": "Pacific/Auckland", "canberra": "Australia/Sydney",
};
// Last parts of IANA IDs that are ordinary words, not places a time question names.
const NOT_PLACES = new Set(["center", "christmas", "easter", "wake", "knox", "salem", "beulah", "monticello", "marengo",
  "midway", "casey", "davis", "palmer", "troll", "vostok", "syowa", "mawson", "rothera", "regina", "dawson",
  "resolute", "creston", "chatham", "eucla", "cocos", "truk", "ponape", "boise", "nome", "jersey", "man"]);
let placeTable = null;
function places() {
  if (placeTable) return placeTable;
  const names = new Map();
  const ids = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  for (const id of ids) {
    if (!id.includes("/")) continue;
    const name = id.split("/").at(-1).replace(/_/g, " ").toLowerCase();
    if (!NOT_PLACES.has(name)) names.set(name, id);
  }
  for (const [name, id] of Object.entries(PLACE_ZONES)) names.set(name, id);
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  placeTable = { names, pattern: new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "g") };
  return placeTable;
}
/** The IANA zones of the places named in spoken text, in order, once each. */
export function namedZones(text) {
  const { names, pattern } = places();
  const spoken = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.,!?;:'’"]/g, " ").replace(/-/g, " ");
  const found = new Map();
  for (const match of spoken.matchAll(pattern)) {
    const name = match[0].replace(/\s+/g, " ");
    const zone = names.get(name);
    if (zone && !found.has(zone)) found.set(zone, name);
  }
  return [...found].map(([zone, name]) => ({ zone, name }));
}
/** A place's current time, worked out by the app for its IANA zone. */
export function placeTime(zone, now = new Date(), style = "full") {
  const options = style === "full"
    ? { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", options).format(now);
}
// Cities people ask about most, across the UTC offsets, grouped when they share a time, in every
// clock update: the voice often answers in the same 200 ms slot as the city name, before the
// page can add that place's time (seen live: the app's Sydney time was acknowledged 40 ms before
// the voice said the Los Angeles time as Sydney's), so the answer must already be in context.
export const WORLD_CITIES = [
  ["Honolulu", "Pacific/Honolulu"], ["Anchorage", "America/Anchorage"], ["Denver", "America/Denver"],
  ["Chicago", "America/Chicago"], ["Mexico City", "America/Mexico_City"], ["New York", "America/New_York"],
  ["Sao Paulo", "America/Sao_Paulo"], ["London", "Europe/London"], ["Paris", "Europe/Paris"],
  ["Berlin", "Europe/Berlin"], ["Rome", "Europe/Rome"], ["Madrid", "Europe/Madrid"],
  ["Johannesburg", "Africa/Johannesburg"], ["Cairo", "Africa/Cairo"], ["Istanbul", "Europe/Istanbul"],
  ["Moscow", "Europe/Moscow"], ["Dubai", "Asia/Dubai"], ["India", "Asia/Kolkata"], ["Kathmandu", "Asia/Kathmandu"],
  ["Bangkok", "Asia/Bangkok"], ["Singapore", "Asia/Singapore"], ["Hong Kong", "Asia/Hong_Kong"],
  ["China", "Asia/Shanghai"], ["Tokyo", "Asia/Tokyo"], ["Seoul", "Asia/Seoul"], ["Sydney", "Australia/Sydney"],
  ["Melbourne", "Australia/Melbourne"], ["Auckland", "Pacific/Auckland"],
];
/** The world cities' times, grouped when they share one ("Tokyo, Seoul Sat 5:21 AM; …"), or with
 * every city next to its own time (the session prompt: read from the grouped list, "Paris, Berlin,
 * Rome, Madrid, Johannesburg Fri 11:59 PM" came out as "11:02 PM in Paris", Oct 16). */
export function worldTimes(now = new Date(), grouped = true) {
  if (!grouped) return WORLD_CITIES.map(([city, zone]) => `${city} ${placeTime(zone, now, "short")}`).join("; ");
  const groups = new Map();
  for (const [city, zone] of WORLD_CITIES) {
    const time = placeTime(zone, now, "short");
    groups.set(time, [...(groups.get(time) || []), city]);
  }
  return [...groups].map(([time, cities]) => `${cities.join(", ")} ${time}`).join("; ");
}
export function worldClock(now = new Date()) {
  return `Elsewhere now (worked out by the app; say a place's time as listed, never add offsets yourself): ${worldTimes(now)}.`;
}
/** Quiet context with the current time in each place named, or "" when none is recognized. */
export function namedPlacesContext(text, now = new Date()) {
  const named = namedZones(text);
  if (!named.length) return "";
  const lines = named.map(({ zone, name }) => `${name.replace(/\b\w/g, (c) => c.toUpperCase())} (${zone}): ${placeTime(zone, now)}`);
  return `Time now in the place the user named, worked out by the app at ${now.toISOString()}. Say this time exactly; never work it out from the local time or a time-zone offset: ${lines.join("; ")}.`;
}

export function clockSnapshot(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone, dateStyle: "full", timeStyle: "short",
  }).format(now);
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone, timeZoneName: "long",
  }).formatToParts(now).find(part => part.type === "timeZoneName").value;
  return {
    id: "browser-clock",
    revision: `${Math.floor(now.getTime() / 60000)}:${timeZone}`,
    context: `Current browser-local date and time: ${local}, ${zoneName}, zone ${timeZone}, ${now.toISOString().slice(11, 16)} UTC. Quiet clock context: never announce it; answer date/time questions from it without Hermes. ${worldClock(now)}`,
  };
}

export class ClockContext extends MemoryContext {
  constructor(append, accepted = () => {}, snapshot = clockSnapshot, options = {}) {
    super(append, accepted, options);
    this.snapshot = snapshot;
    this.timer = null;
  }
  start() {
    // Check locally each second; send only when the minute or zone changes.
    if (this.timer === null) this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }
  refresh() {
    if (this.timer === null) return;
    const snapshot = this.snapshot();
    const pending = this.inflight.get(snapshot.id);
    // A missing acknowledgment must not hold a later minute behind an old clock.
    if (pending && pending.model.revision !== snapshot.revision)
      this.inflight.delete(snapshot.id);
    this.receive([snapshot]);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.reset();
  }
}

// Fix 5 (Part 3): a plain date or time question, here or in another city. The speech policy says
// these come from the browser clock, never a handoff; when the voice hands one off anyway, the app
// answers that delegation from the clock (client delegation: the application performs the work and
// returns the result as context; MS Learn, "Delegate work in GPT-Live"). Seen live: "So can you
// check, uh, what time it is in Tokyo" handed to Hermes with "Let me add the offset." first.
const TIME_QUESTION = /\b(?:what(?:'s| is)?(?: the)? (?:time|date|day)|what time|time is it|time it is|today'?s date)\b/i;
const OTHER_WORK = /\b(?:remind|reminder|schedule|book|send|calendar|meeting|alarm|timer|appointment|flight|weather|open|close|until|since|ago|last time|next time)\b/i;
export function clockQuestion(text) {
  const s = String(text || "");
  return TIME_QUESTION.test(s) && !OTHER_WORK.test(s);
}
