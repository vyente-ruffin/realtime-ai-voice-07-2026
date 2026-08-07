// M2.T1 — ACP client lifecycle + permission policy.
// Tests 1 (handshake [A5]), 2 (session isolation [A2]), 3 (no orphans),
// 5 (destructive permission requests are NOT auto-approved [A9]).
import { AcpClient } from "../../src/acp-client.js";

let fail = 0;
const ok = (n, msg) => console.log(`  PASS m2.t1.${n}: ${msg}`);
const bad = (n, msg) => { console.log(`  FAIL m2.t1.${n}: ${msg}`); fail = 1; };

function pidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Test 1: handshake returns capabilities [A5] ---
const a = new AcpClient();
let capsOk = false;
try {
  const init = await a.start();
  capsOk = init && init.agentCapabilities !== undefined && init.protocolVersion !== undefined;
  capsOk ? ok(1, `initialize returned protocolVersion=${init.protocolVersion} + capabilities`)
         : bad(1, "initialize response missing protocolVersion/capabilities");
} catch (err) {
  bad(1, `initialize threw: ${err.message}`);
}

// --- Test 2: two concurrent sessions => two children, distinct ids [A2] ---
const b = new AcpClient();
try {
  await b.start();
  const idA = await a.newSession();
  const idB = await b.newSession();
  const pidA = a.child?.pid;
  const pidB = b.child?.pid;
  if (idA && idB && idA !== idB && pidA !== pidB && pidAlive(pidA) && pidAlive(pidB)) {
    ok(2, `distinct sessions (${idA.slice(0, 8)}…, ${idB.slice(0, 8)}…) on children ${pidA}, ${pidB}`);
  } else {
    bad(2, `idA=${idA} idB=${idB} pidA=${pidA} pidB=${pidB}`);
  }
} catch (err) {
  bad(2, `session/new threw: ${err.message}`);
}

// --- Test 5: destructive permission request is NOT auto-approved [A9] ---
// Simulated at the policy layer: the client's decision function must not
// select an allow option for a non-read request.
try {
  const destructive = {
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: { title: "Delete staging database", kind: "execute" },
  };
  const readish = {
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: { title: "Read file README.md", kind: "read" },
  };
  const dDecision = a.decidePermission(destructive);
  const rDecision = a.decidePermission(readish);
  if (dDecision.autoAnswer === false && rDecision.autoAnswer === true &&
      rDecision.optionId === "allow-once" &&
      a.rejectOptionId(destructive) === "reject-once") {
    ok(5, "destructive request deferred to confirmation; read-class auto-allowed [A9]");
  } else {
    bad(5, `policy wrong: destructive=${JSON.stringify(dDecision)} read=${JSON.stringify(rDecision)}`);
  }
} catch (err) {
  bad(5, `permission policy threw: ${err.message}`);
}

// --- Test 3: no orphans within 5s of stop() ---
const stoppedPids = [a.child?.pid, b.child?.pid].filter(Number.isInteger);
await a.stop();
await b.stop();
let settled = false;
for (let i = 0; i < 25; i++) {
  if (stoppedPids.every((pid) => !pidAlive(pid))) { settled = true; break; }
  await new Promise((r) => setTimeout(r, 200));
}
settled ? ok(3, "both owned ACP child PIDs exited within 5s")
        : bad(3, `owned ACP child still alive: ${stoppedPids.filter(pidAlive).join(",")}`);

process.exit(fail);
