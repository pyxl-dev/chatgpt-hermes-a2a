import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = "/Users/yoan/Projects/chatgpt-hermes-a2a";
const bridge = path.join(root, "scripts", "start-bridge.sh");
const resultPath = "/tmp/native-coordinator-e2e-result.json";
const scope = "e2e-native-restart-20260930-cobalt-4817";
const meta = { "openai/session": scope };
const terminal = new Set(["completed", "failed", "cancelled", "canceled", "interrupted", "rejected"]);

function textOf(result) {
  return (result?.content || [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text || "")
    .join("\n");
}

function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  try { return JSON.parse(text); } catch { return { text }; }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);

async function openClient(name) {
  const transport = new StdioClientTransport({
    command: "/bin/bash",
    args: [bridge],
    env: childEnv,
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args, _meta: meta });
}

async function poll(client, runId, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await call(client, "get_hermes_run", { runId });
    const payload = payloadOf(result);
    if (terminal.has(String(payload?.status || "").toLowerCase())) return payload;
    await sleep(750);
  }
  throw new Error("Timed out polling " + runId);
}

const summary = {
  ok: false,
  syntheticScope: scope,
  sessionId: null,
  firstRunId: null,
  secondRunId: null,
  sameSessionAfterWrapperRestart: false,
  recalledA: false,
  rememberedB: false,
  concurrencyRunId: null,
  concurrencyRejected: false,
  concurrencyErrorCode: null,
  stoppedRunTerminalState: null,
  errors: [],
};

let first = null;
let second = null;

try {
  first = await openClient("native-e2e-first");
  const started1 = await call(first, "start_hermes_run", {
    instruction: "TEST RUNTIME UNIQUEMENT. N'utilise aucun outil et ne modifie rien. Mémorise exactement NATIVE_A=COBALT-4817 et réponds uniquement NATIVE_A=COBALT-4817.",
  });
  const p1 = payloadOf(started1);
  if (started1?.isError || p1?.ok === false || !p1?.runId) {
    throw new Error("First run start failed: " + JSON.stringify(p1));
  }
  summary.firstRunId = p1.runId;
  const done1 = await poll(first, p1.runId);
  if (String(done1?.status).toLowerCase() !== "completed" || !done1?.sessionId) {
    throw new Error("First run did not complete with durable session: " + JSON.stringify(done1));
  }
  summary.sessionId = done1.sessionId;
  await first.close();
  first = null;

  second = await openClient("native-e2e-second");
  const started2 = await call(second, "start_hermes_run", {
    instruction: "TEST RUNTIME UNIQUEMENT. N'utilise aucun outil et ne modifie rien. Sans que je te redonne NATIVE_A, restitue sa valeur depuis l'historique puis mémorise NATIVE_B=AMBRE-6204. Réponds uniquement NATIVE_A=<valeur> | NATIVE_B=AMBRE-6204.",
  });
  const p2 = payloadOf(started2);
  if (started2?.isError || p2?.ok === false || !p2?.runId) {
    throw new Error("Second run start failed: " + JSON.stringify(p2));
  }
  summary.secondRunId = p2.runId;
  const done2 = await poll(second, p2.runId);
  const output2 = typeof done2?.output === "string" ? done2.output : JSON.stringify(done2?.output ?? "");
  summary.sameSessionAfterWrapperRestart = done2?.sessionId === summary.sessionId;
  summary.recalledA = output2.includes("COBALT-4817");
  summary.rememberedB = output2.includes("AMBRE-6204");
  if (String(done2?.status).toLowerCase() !== "completed") {
    throw new Error("Second run status: " + JSON.stringify(done2));
  }

  const longStarted = await call(second, "start_hermes_run", {
    instruction: "TEST RUNTIME UNIQUEMENT. Utilise le terminal uniquement pour exécuter exactement `python3 -c \"import time; time.sleep(20)\"`, puis réponds uniquement CONCURRENCY_DONE. Ne modifie aucun fichier.",
  });
  const longPayload = payloadOf(longStarted);
  if (longStarted?.isError || longPayload?.ok === false || !longPayload?.runId) {
    throw new Error("Long run start failed: " + JSON.stringify(longPayload));
  }
  summary.concurrencyRunId = longPayload.runId;

  try {
    const competing = await call(second, "start_hermes_run", {
      instruction: "TEST CONCURRENCE. Réponds uniquement SHOULD_NOT_START.",
    });
    const cp = payloadOf(competing);
    summary.concurrencyErrorCode = cp?.error?.code || cp?.code || null;
    summary.concurrencyRejected =
      competing?.isError === true ||
      cp?.ok === false ||
      summary.concurrencyErrorCode === "HERMES_SESSION_BUSY";
  } catch (error) {
    const msg = String(error?.message || error);
    summary.concurrencyErrorCode = msg.includes("HERMES_SESSION_BUSY") ? "HERMES_SESSION_BUSY" : null;
    summary.concurrencyRejected = summary.concurrencyErrorCode === "HERMES_SESSION_BUSY";
  }

  const stop = await call(second, "stop_hermes_run", { runId: summary.concurrencyRunId });
  const stopPayload = payloadOf(stop);
  if (stop?.isError || stopPayload?.ok === false) {
    throw new Error("Stop failed: " + JSON.stringify(stopPayload));
  }
  const stopped = await poll(second, summary.concurrencyRunId, 60000);
  summary.stoppedRunTerminalState = stopped?.status || null;

  summary.ok =
    summary.sameSessionAfterWrapperRestart &&
    summary.recalledA &&
    summary.rememberedB &&
    summary.concurrencyRejected &&
    summary.concurrencyErrorCode === "HERMES_SESSION_BUSY";
} catch (error) {
  summary.errors.push(String(error?.stack || error?.message || error));
} finally {
  if (first) { try { await first.close(); } catch {} }
  if (second) { try { await second.close(); } catch {} }
  await fs.writeFile(resultPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

process.stdout.write(JSON.stringify(summary) + "\n");
