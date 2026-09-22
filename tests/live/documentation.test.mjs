/** Guard the required lossless split: historical README bytes must not be edited away. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

test("ledger preserves the entire original README byte for byte", () => {
  const ledger = readFileSync(new URL("../../ledger.md", import.meta.url), "utf8");
  const start = ledger.indexOf("# 🎙️ Realtime AI Voice — Talk to GPT Realtime on Azure AI Foundry");
  const end = ledger.indexOf("\n## 2026-09-22 — Browser observability and local clock context (t_a1acaa58)");
  assert.ok(start >= 0 && end > start);
  const hash = createHash("sha256").update(ledger.slice(start, end)).digest("hex");
  assert.equal(hash, "350d31428fed7d7846289b13442fcb29ab3aafe06ac9dcbb9af2dedaf855ca6f");
});
