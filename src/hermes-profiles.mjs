import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PROFILE = "default";

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function profileError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.deliveryAmbiguous = false;
  if (details) error.details = details;
  return error;
}

// null/undefined means "not chosen"; anything else must be a plain profile id.
export function normalizeProfile(value) {
  if (value === undefined || value === null) return null;
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw profileError(
      "HERMES_PROFILE_INVALID",
      "profile must be a Hermes profile name (letters, digits, '-' or '_'). Call list_hermes_profiles to see them.",
      { profile: value },
    );
  }
  return name;
}

export function profileOrDefault(value) {
  return typeof value === "string" && value ? value : DEFAULT_PROFILE;
}

export function resolveHermesHome(env = process.env) {
  const explicit = String(env.HERMES_ROOT_HOME || env.HERMES_HOME || "").trim();
  return explicit || path.join(os.homedir(), ".hermes");
}

function unquote(value) {
  const text = value.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

// Reads one KEY=value line from a dotenv file without loading anything else.
export function readEnvValue(raw, key) {
  for (const line of String(raw || "").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(
      line,
    );
    if (match && match[1] === key) return unquote(match[2]);
  }
  return "";
}

// Hermes writes profile.yaml with a single top-level description scalar,
// folded over several indented lines when it is long. This reads just that.
export function readYamlScalar(raw, key) {
  const lines = String(raw || "").split("\n");
  const start = lines.findIndex((line) => line.startsWith(key + ":"));
  if (start < 0) return null;
  const parts = [lines[start].slice(key.length + 1).trim()];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/u.test(line)) break;
    parts.push(line.trim());
  }
  let value = parts.filter(Boolean).join(" ");
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    value = value.slice(1, -1).replaceAll("''", "'");
  } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value || null;
}

// config.yaml keeps the model either as "model: name" or as a block whose
// "default:" child names it.
export function readConfiguredModel(raw) {
  const lines = String(raw || "").split("\n");
  const start = lines.findIndex((line) => /^model:/u.test(line));
  if (start < 0) return null;
  const inline = unquote(lines[start].slice("model:".length));
  if (inline) return inline;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/u.test(line)) break;
    const match = /^\s+default:\s*(.+)$/u.exec(line);
    if (match) return unquote(match[1]) || null;
  }
  return null;
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
    throw error;
  }
}

export function createHermesProfiles({
  hermesHome = resolveHermesHome(),
  defaultApiKey = "",
} = {}) {
  function profileDir(name) {
    return name === DEFAULT_PROFILE
      ? hermesHome
      : path.join(hermesHome, "profiles", name);
  }

  async function namedProfiles() {
    let entries = [];
    try {
      entries = await fs.readdir(path.join(hermesHome, "profiles"), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === DEFAULT_PROFILE) continue;
      if (!PROFILE_NAME_PATTERN.test(entry.name)) continue;
      const dir = profileDir(entry.name);
      const marked = await Promise.all(
        ["profile.yaml", "config.yaml"].map((file) =>
          fs.access(path.join(dir, file)).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (marked.some(Boolean)) names.push(entry.name);
    }
    return names.sort();
  }

  async function exists(name) {
    return name === DEFAULT_PROFILE || (await namedProfiles()).includes(name);
  }

  // The bridge only ever reads API_SERVER_KEY from a profile's .env: under
  // Hermes' multiplexed gateway, /p/<profile>/ requests must carry that key.
  async function apiKey(name) {
    if (name === DEFAULT_PROFILE) return defaultApiKey;
    if (!(await exists(name))) return "";
    const raw = await readOptional(path.join(profileDir(name), ".env"));
    return readEnvValue(raw, "API_SERVER_KEY");
  }

  async function describe(name) {
    const dir = profileDir(name);
    const [profileYaml, configYaml, key] = await Promise.all([
      readOptional(path.join(dir, "profile.yaml")),
      readOptional(path.join(dir, "config.yaml")),
      apiKey(name),
    ]);
    return {
      name,
      isDefault: name === DEFAULT_PROFILE,
      description: readYamlScalar(profileYaml, "description"),
      model: readConfiguredModel(configYaml),
      available: Boolean(key),
    };
  }

  async function listProfiles() {
    const names = [DEFAULT_PROFILE, ...(await namedProfiles())];
    const profiles = await Promise.all(names.map(describe));
    return {
      ok: true,
      operation: "list_hermes_profiles",
      agent: "hermes",
      count: profiles.length,
      profiles,
      ...(profiles.some((profile) => !profile.available)
        ? {
            note: "Profiles with available:false have no API_SERVER_KEY of their own yet; the user enables one with scripts/setup-hermes-control.sh --profile <name>.",
          }
        : {}),
    };
  }

  async function requireApiKey(name) {
    const profile = profileOrDefault(name);
    if (profile !== DEFAULT_PROFILE && !(await exists(profile))) {
      throw profileError(
        "HERMES_PROFILE_NOT_FOUND",
        "Hermes has no profile named '" +
          profile +
          "'. Call list_hermes_profiles to see the available ones.",
        { profile },
      );
    }
    const key = await apiKey(profile);
    if (!key) {
      throw profileError(
        "HERMES_PROFILE_NOT_CONFIGURED",
        "Hermes profile '" +
          profile +
          "' has no API_SERVER_KEY of its own, so the bridge cannot reach it. The user can enable it with: bash scripts/setup-hermes-control.sh --profile " +
          profile,
        { profile },
      );
    }
    return key;
  }

  return { hermesHome, listProfiles, requireApiKey, exists };
}
