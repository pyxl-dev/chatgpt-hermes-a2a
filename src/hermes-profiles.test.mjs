import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHermesControl, profilePathPrefix } from "./hermes-control.mjs";
import {
  createHermesProfiles,
  normalizeProfile,
  readConfiguredModel,
  readEnvValue,
  readYamlScalar,
} from "./hermes-profiles.mjs";
import { createHermesSessionCoordinator } from "./hermes-session-coordinator.mjs";

async function makeHermesHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profiles-"));
  const write = async (relative, content) => {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  await write("config.yaml", "model:\n  default: base-model\n  provider: x\n");
  await write(
    "profiles/rea/profile.yaml",
    "description: 'Reverse engineering dédié (Ghidra): binaires\n  natifs, l''iOS et firmware.'\ndescription_auto: false\n",
  );
  await write("profiles/rea/config.yaml", "model:\n  default: rea-model\n");
  await write("profiles/rea/.env", "OTHER=1\nAPI_SERVER_KEY='rea-key'\n");
  await write("profiles/youtube/profile.yaml", "description: Chaîne YouTube\n");
  await write("profiles/ghost/notes.txt", "not a profile");
  return home;
}

test("profile names are validated and normalized", () => {
  assert.equal(normalizeProfile(undefined), null);
  assert.equal(normalizeProfile(" REA "), "rea");
  for (const bad of ["", "../etc", "a/b", "x".repeat(70), 3]) {
    assert.throws(() => normalizeProfile(bad), { code: "HERMES_PROFILE_INVALID" });
  }
});

test("profile metadata parsers read only what they need", () => {
  assert.equal(readEnvValue("A=1\nexport API_SERVER_KEY=\"k\"\n", "API_SERVER_KEY"), "k");
  assert.equal(readEnvValue("A=1\n", "API_SERVER_KEY"), "");
  assert.equal(
    readYamlScalar("description: 'one\n  two, l''x'\nnext: 1\n", "description"),
    "one two, l'x",
  );
  assert.equal(readConfiguredModel("model: plain\n"), "plain");
  assert.equal(readConfiguredModel("model:\n  provider: p\n  default: m\n"), "m");
});

test("listProfiles exposes descriptions and availability, never keys", async () => {
  const home = await makeHermesHome();
  const profiles = createHermesProfiles({ hermesHome: home, defaultApiKey: "default-key" });
  const listed = await profiles.listProfiles();
  assert.deepEqual(
    listed.profiles.map((profile) => profile.name),
    ["default", "rea", "youtube"],
  );
  const rea = listed.profiles.find((profile) => profile.name === "rea");
  assert.equal(rea.description, "Reverse engineering dédié (Ghidra): binaires natifs, l'iOS et firmware.");
  assert.equal(rea.model, "rea-model");
  assert.equal(rea.available, true);
  assert.equal(listed.profiles[0].model, "base-model");
  assert.equal(listed.profiles.find((profile) => profile.name === "youtube").available, false);
  assert.match(listed.note, /setup-hermes-control\.sh --profile/);
  assert.doesNotMatch(JSON.stringify(listed), /rea-key|default-key/);

  assert.equal(await profiles.requireApiKey("rea"), "rea-key");
  assert.equal(await profiles.requireApiKey(null), "default-key");
  await assert.rejects(profiles.requireApiKey("youtube"), {
    code: "HERMES_PROFILE_NOT_CONFIGURED",
  });
  await assert.rejects(profiles.requireApiKey("ghost"), {
    code: "HERMES_PROFILE_NOT_FOUND",
  });
});

test("control routes a named profile under /p/<profile>/ with that profile's key", async () => {
  assert.equal(profilePathPrefix(null), "");
  assert.equal(profilePathPrefix("default"), "");
  assert.equal(profilePathPrefix("rea"), "/p/rea");

  const home = await makeHermesHome();
  const seen = [];
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.HERMES_API_SERVER_URL, key: process.env.API_SERVER_KEY };
  process.env.HERMES_API_SERVER_URL = "http://127.0.0.1:9";
  process.env.API_SERVER_KEY = "default-key";
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.get("Authorization") });
    return new Response(JSON.stringify({ run_id: "run-1", status: "running" }));
  };
  try {
    const control = createHermesControl({
      redactText: String,
      redactValue: (value) => value,
      profiles: createHermesProfiles({ hermesHome: home, defaultApiKey: "default-key" }),
    });
    const started = await control.startRun("work", null, "scope", { profile: "rea" });
    assert.equal(started.profile, "rea");
    await control.getRun("run-1");
    assert.deepEqual(seen, [
      { url: "http://127.0.0.1:9/p/rea/v1/runs", auth: "Bearer rea-key" },
      { url: "http://127.0.0.1:9/v1/runs/run-1", auth: "Bearer default-key" },
    ]);
    await assert.rejects(
      control.startRun("work", null, "scope", { profile: "youtube" }),
      (error) =>
        error.code === "HERMES_PROFILE_NOT_CONFIGURED" &&
        error.deliveryAmbiguous === false,
    );
    assert.equal(seen.length, 2, "an unconfigured profile is never contacted");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, env] of [["url", "HERMES_API_SERVER_URL"], ["key", "API_SERVER_KEY"]]) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  }
});

async function makeCoordinator() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profile-slots-"));
  let counter = 0;
  return createHermesSessionCoordinator({
    root,
    randomUUID: () => "profile-id-" + ++counter,
  });
}

async function runToCompletion(coordinator, scope, { instruction, profile, runId, sessionId, replaceSession = false }) {
  const lease = await coordinator.begin(scope, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction,
    profile,
    replaceSession,
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId, sessionId, status: "running" },
    runId,
    sessionId,
    keepActive: true,
    activeKind: "run",
  });
  await coordinator.observe(scope, {
    kind: "run",
    id: runId,
    terminal: true,
    sessionId,
    status: "completed",
  });
  return lease;
}

test("a slot keeps the profile of its session and refuses a silent switch", async () => {
  const coordinator = await makeCoordinator();
  const scope = coordinator.scopeFromMeta({ "openai/session": "profile-chat" });

  const first = await runToCompletion(coordinator, scope, {
    instruction: "analyse this binary",
    profile: "rea",
    runId: "r1",
    sessionId: "s1",
  });
  assert.equal(first.profile, "rea");

  const followUp = await coordinator.begin(scope, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction: "and the next function",
  });
  assert.equal(followUp.profile, "rea", "follow-ups stay in the slot's profile");
  assert.equal(followUp.sessionIdToUse, "s1");
  assert.equal((await coordinator.inspect(scope)).active.profile, "rea");
  await coordinator.fail(scope, followUp.operationId);

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "start_hermes_run",
      tool: "start_hermes_run",
      instruction: "write a video script",
      profile: "youtube",
    }),
    (error) =>
      error.code === "HERMES_PROFILE_MISMATCH" &&
      error.details.boundProfile === "rea" &&
      error.details.requestedProfile === "youtube" &&
      error.details.freeSlots.includes(2),
  );

  const slot2 = await coordinator.scopeForSlot(scope, { slot: 2 });
  const parallel = await coordinator.begin(slot2, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction: "write a video script",
    profile: "youtube",
  });
  assert.equal(parallel.profile, "youtube");
  assert.equal(parallel.sessionIdToUse, null);
});

test("replaceSession switches a slot's profile, and a failed submission restores it", async () => {
  const coordinator = await makeCoordinator();
  const scope = coordinator.scopeFromMeta({ "openai/session": "profile-switch" });
  await runToCompletion(coordinator, scope, {
    instruction: "general work",
    runId: "r1",
    sessionId: "s-default",
  });
  assert.equal((await coordinator.inspect(scope)).profile, "default");

  const switching = await coordinator.begin(scope, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction: "reverse this",
    profile: "rea",
    replaceSession: true,
  });
  assert.equal(switching.profile, "rea");
  assert.equal(switching.sessionIdToUse, null);
  await coordinator.fail(scope, switching.operationId);
  const restored = await coordinator.inspect(scope);
  assert.equal(restored.profile, "default");
  assert.equal(restored.canonicalSessionId, "s-default");

  await runToCompletion(coordinator, scope, {
    instruction: "reverse this",
    profile: "rea",
    runId: "r2",
    sessionId: "s-rea",
    replaceSession: true,
  });
  const switched = await coordinator.inspect(scope);
  assert.equal(switched.profile, "rea");
  assert.equal(switched.canonicalSessionId, "s-rea");
  assert.equal(switched.archivedSessions.at(-1).profile, "default");
});

test("the same instruction is never replayed across profiles", async () => {
  const coordinator = await makeCoordinator();
  const chat = coordinator.scopeFromMeta({ "openai/session": "replay-chat" });
  const lease = await coordinator.begin(chat, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "summarise the week",
  });
  await coordinator.complete(chat, lease.operationId, {
    payload: { ok: true, status: "completed", runId: "r1", sessionId: "s1", text: "done" },
    runId: "r1",
    sessionId: "s1",
  });

  const otherProfile = await coordinator.begin(chat, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "summarise the week",
    profile: "veille-ia",
    replaceSession: true,
  });
  assert.equal(otherProfile.replay, false, "another profile must run it again");
  assert.equal(otherProfile.profile, "veille-ia");
  await coordinator.fail(chat, otherProfile.operationId);

  const replay = await coordinator.begin(chat, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "summarise the week",
  });
  assert.equal(replay.replay, true, "same profile, same instruction replays");
});
