import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// A local durable outbox, not a replacement for either upstream database.
export class VoiceStore {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, created INTEGER, active_session TEXT);
      CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY, conversation TEXT REFERENCES conversations(id), session TEXT, role TEXT, text TEXT, at INTEGER, start_ms REAL, end_ms REAL, retained INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS fragments_conversation ON fragments(conversation,at);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, conversation TEXT REFERENCES conversations(id), delegation TEXT, session TEXT, state TEXT, request TEXT, result TEXT, error TEXT, created INTEGER, updated INTEGER, UNIQUE(session,delegation));
      CREATE TABLE IF NOT EXISTS deliveries(job TEXT PRIMARY KEY REFERENCES jobs(id), state TEXT, session TEXT, event TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS retention(id TEXT PRIMARY KEY, conversation TEXT, content TEXT, state TEXT, operation TEXT, attempts INTEGER DEFAULT 0, next_at INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY, value TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, conversation TEXT, kind TEXT, payload TEXT, at INTEGER);`);
  }
  close() {
    this.db.close();
  }
  conversation(id) {
    return id
      ? this.db.prepare("SELECT * FROM conversations WHERE id=?").get(id)
      : null;
  }
  createConversation() {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO conversations VALUES(?,?,NULL)")
      .run(id, Date.now());
    return this.conversation(id);
  }
  defaultConversation() {
    const saved = this.cache("default-conversation");
    const existing = this.conversation(saved?.value);
    if (existing) return existing;
    const conversation = this.createConversation();
    this.putCache("default-conversation", conversation.id);
    return conversation;
  }
  activate(id, session) {
    this.db
      .prepare("UPDATE conversations SET active_session=? WHERE id=?")
      .run(session, id);
  }
  fragment(conversation, session, event) {
    if (
      ![
        "session.input_transcript.delta",
        "session.output_transcript.delta",
      ].includes(event.type) ||
      !event.delta?.trim()
    )
      return false;
    const role =
      event.type === "session.input_transcript.delta" ? "user" : "assistant";
    const id = `${session}:${event.event_id || `${role}:${event.start_ms}:${event.end_ms}:${event.delta}`}`;
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO fragments(id,conversation,session,role,text,at,start_ms,end_ms) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          conversation,
          session,
          role,
          event.delta,
          Date.now(),
          event.start_ms || 0,
          event.end_ms || 0,
        ).changes > 0
    );
  }
  history(conversation, count = 200) {
    return this.db
      .prepare(
        "SELECT * FROM (SELECT rowid AS sequence,* FROM fragments WHERE conversation=? ORDER BY at DESC,rowid DESC LIMIT ?) ORDER BY at,sequence",
      )
      .all(conversation, count);
  }
  recentUserStatements() {
    return this.db
      .prepare(
        "SELECT text FROM fragments WHERE role='user' AND at>? ORDER BY at DESC LIMIT 60",
      )
      .all(Date.now() - 7 * 86400000)
      .reverse()
      .map((x) => x.text)
      .join("")
      .slice(-1800);
  }
  jobs(conversation) {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE conversation=? ORDER BY created DESC LIMIT 50",
      )
      .all(conversation);
  }
  job(id) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  }
  enqueue(conversation, session, delegation, request) {
    const id = randomUUID(),
      now = Date.now();
    this.db
      .prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        conversation,
        delegation,
        session,
        "queued",
        request,
        null,
        null,
        now,
        now,
      );
    return this.db
      .prepare("SELECT * FROM jobs WHERE session=? AND delegation=?")
      .get(session, delegation);
  }
  nextJob() {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1",
      )
      .get();
  }
  updateJob(id, state, { result = null, error = null } = {}) {
    this.db
      .prepare(
        "UPDATE jobs SET state=?,result=COALESCE(?,result),error=?,updated=? WHERE id=?",
      )
      .run(state, result, error, Date.now(), id);
    return this.job(id);
  }
  recover() {
    this.db
      .prepare(
        "UPDATE jobs SET state='interrupted',error='The voice service restarted during this work. Its outcome needs checking; it was not run again.',updated=? WHERE state IN ('running','awaiting_permission')",
      )
      .run(Date.now());
    this.db
      .prepare("UPDATE retention SET state='pending' WHERE state='sending'")
      .run();
  }
  offer(job, session) {
    const previous = this.db
      .prepare("SELECT * FROM deliveries WHERE job=?")
      .get(job.id);
    // Acknowledgment means model context injection, never proof of heard speech.
    // Ambiguous delivery after a disconnect remains visible; do not repeat it blindly.
    if (previous && previous.state !== "available") return null;
    const event = `result_${randomUUID()}`;
    this.db
      .prepare(
        "INSERT INTO deliveries VALUES(?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET state=excluded.state,session=excluded.session,event=excluded.event,updated=excluded.updated",
      )
      .run(job.id, "offered", session, event, Date.now());
    return { event, job: job.id };
  }
  deliveryAck(job, session, event) {
    return (
      this.db
        .prepare(
          "UPDATE deliveries SET state='injected',updated=? WHERE job=? AND session=? AND event=? AND state='offered'",
        )
        .run(Date.now(), job, session, event).changes > 0
    );
  }
  releaseOffer(job, session, event) {
    this.db
      .prepare(
        "UPDATE deliveries SET state='available',updated=? WHERE job=? AND session=? AND event=? AND state='offered'",
      )
      .run(Date.now(), job, session, event);
  }
  delivery(job) {
    return this.db.prepare("SELECT * FROM deliveries WHERE job=?").get(job);
  }
  remember(conversation, content) {
    if (!content.trim()) return;
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO retention VALUES(?,?,?,?,?,0,?,NULL)")
      .run(id, conversation, content, "pending", id, Date.now());
    return id;
  }
  queueMemory() {
    const conversations = this.db
      .prepare(
        "SELECT conversation FROM fragments WHERE retained=0 AND role='user' GROUP BY conversation HAVING MAX(at)<?",
      )
      .all(Date.now() - 3000);
    for (const { conversation } of conversations) {
      const rows = this.db
        .prepare(
          "SELECT * FROM fragments WHERE conversation=? AND retained=0 AND role='user' ORDER BY at,rowid",
        )
        .all(conversation);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.remember(
          conversation,
          joinedTurns(rows)
            .map((x) => "User said: " + x.text)
            .join("\n"),
        );
        this.db
          .prepare(
            "UPDATE fragments SET retained=1 WHERE conversation=? AND role='user' AND retained=0",
          )
          .run(conversation);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  pendingMemory() {
    return this.db
      .prepare(
        "SELECT * FROM retention WHERE state IN ('pending','submitted') AND next_at<=? ORDER BY next_at LIMIT 1",
      )
      .get(Date.now());
  }
  memoryState(id, state, error = null, delay = 0) {
    this.db
      .prepare(
        "UPDATE retention SET state=?,error=?,attempts=attempts+1,next_at=? WHERE id=?",
      )
      .run(state, error, Date.now() + delay, id);
  }
  memoryHealth() {
    return this.db
      .prepare("SELECT state,COUNT(*) AS count FROM retention GROUP BY state")
      .all();
  }
  putCache(key, value) {
    this.db
      .prepare(
        "INSERT INTO cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at",
      )
      .run(key, JSON.stringify(value), Date.now());
  }
  cache(key) {
    const r = this.db.prepare("SELECT * FROM cache WHERE key=?").get(key);
    return r ? { value: JSON.parse(r.value), at: r.at } : null;
  }
  audit(conversation, kind, payload = {}) {
    this.db
      .prepare(
        "INSERT INTO audit(conversation,kind,payload,at) VALUES(?,?,?,?)",
      )
      .run(conversation, kind, JSON.stringify(payload), Date.now());
  }
}

export function joinedTurns(fragments) {
  const turns = [];
  for (const f of fragments) {
    const previous = turns.at(-1);
    if (
      previous &&
      previous.role === f.role &&
      previous.session === f.session &&
      f.start_ms - previous.end_ms < 1800
    ) {
      previous.text += f.text;
      previous.end_ms = f.end_ms;
    } else
      turns.push({
        role: f.role,
        text: f.text,
        session: f.session,
        end_ms: f.end_ms,
      });
  }
  return turns;
}
export function liveHistory(fragments) {
  const history = [];
  let remaining = 6000;
  for (const turn of joinedTurns(fragments).reverse()) {
    const text = turn.text.trim().slice(-1200);
    if (!text) continue;
    if (history.length === 24 || text.length > remaining) break;
    remaining -= text.length;
    history.unshift({
      type: "message",
      role: turn.role,
      content: [
        { type: turn.role === "user" ? "input_text" : "output_text", text },
      ],
    });
  }
  return history;
}
