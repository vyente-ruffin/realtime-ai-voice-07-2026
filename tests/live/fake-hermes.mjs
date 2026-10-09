/** In-process stand-in for the Hermes API server Runs API (shapes taken from a real 0.21.6 run). */
export function fakeHermes({ cap = 10 } = {}) {
  const runs = new Map();
  const keys = new Map();
  const calls = [];
  const state = { down: false, health: "ok" };
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const unreachable = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
  function push(run, event) {
    const e = { run_id: run.id, timestamp: Date.now() / 1000, ...event, seq: run.events.length };
    run.events.push(e);
    for (const w of run.waiters.splice(0)) w();
  }
  const finalEvent = { completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled", interrupted: "run.interrupted" };
  const api = {
    runs,
    calls,
    state,
    active: () => [...runs.values()].filter((r) => !finalEvent[r.status]).length,
    complete(id, output) {
      const run = runs.get(id);
      run.status = "completed";
      run.output = output;
      push(run, { event: "run.completed", output });
    },
    event(id, event) {
      push(runs.get(id), event);
    },
    /** Gateway restart: in-flight runs persist as interrupted, open streams drop. */
    restart() {
      for (const run of runs.values())
        if (!finalEvent[run.status]) {
          run.status = "interrupted";
          run.error = "Gateway shutdown interrupted the run.";
        }
      for (const run of runs.values()) {
        run.dropped = true;
        for (const w of run.waiters.splice(0)) w();
      }
    },
    async fetch(url, init = {}) {
      const u = new URL(url);
      const method = init.method || "GET";
      calls.push({ method, path: u.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
      if (state.down) return unreachable();
      if (u.pathname === "/health") return json(200, { status: state.health });
      if (method === "POST" && u.pathname === "/v1/runs") {
        const key = init.headers?.["Idempotency-Key"];
        if (key && keys.has(key)) return json(202, { run_id: keys.get(key), status: "started", replayed: true });
        if (api.active() >= cap) return json(429, { error: { message: `Too many concurrent runs (max ${cap})` } });
        const id = `run_${runs.size + 1}`;
        const body = JSON.parse(init.body);
        runs.set(id, { id, status: "running", body, events: [], waiters: [], session_id: body.session_id });
        if (key) keys.set(key, id);
        return json(202, { run_id: id, status: "started", replayed: false });
      }
      const m = u.pathname.match(/^\/v1\/runs\/([^/]+)(\/events|\/stop|\/approval)?$/);
      const run = m && runs.get(decodeURIComponent(m[1]));
      if (!run) return json(404, { error: { message: "Run not found" } });
      if (!m[2]) return json(200, { object: "hermes.run", run_id: run.id, status: run.status, session_id: run.session_id, output: run.output, error: run.error });
      if (m[2] === "/stop") {
        run.status = "cancelled";
        push(run, { event: "run.cancelled" });
        return json(200, { run_id: run.id, status: "stopping" });
      }
      if (m[2] === "/approval") {
        push(run, { event: "approval.responded", choice: JSON.parse(init.body).choice });
        return json(200, { object: "hermes.run.approval_response", run_id: run.id });
      }
      run.dropped = false;
      let next = Number(u.searchParams.get("last_seq") ?? -1) + 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          for (;;) {
            if (run.dropped) return controller.error(new Error("socket hang up"));
            if (next < run.events.length) {
              const e = run.events[next++];
              controller.enqueue(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
              if (finalEvent[run.status] && finalEvent[run.status] === e.event) controller.close();
              return;
            }
            if (finalEvent[run.status]) return controller.close();
            await new Promise((r) => run.waiters.push(r));
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  };
  return api;
}
