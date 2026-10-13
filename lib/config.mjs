// Settings the owner chooses once and expects to be remembered. One file of
// `key=value` lines, read by the CLI and, through `eventloom config get`, by
// the plugin's scripts, so that they cannot disagree.
//
// Whether the log is sealed is deliberately not a setting: an agent can edit
// this file.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function port(text, { lowest }) {
  if (!/^\d{1,5}$/.test(text) || Number(text) < lowest || Number(text) > 65535) {
    throw new Error(`a port is a whole number from ${lowest} to 65535 (got "${text}")`);
  }
  return Number(text);
}

// A remembered port must be one an unprivileged program can open.
const SETTINGS = {
  tapestry_port: { fallback: 4747, parse: (text) => port(text, { lowest: 1024 }), about: "where the Tapestry is served" },
};

export const SETTING_NAMES = Object.keys(SETTINGS);

export function configPath(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "eventloom", "config");
}

function known(key) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(`"${key}" is not a setting (there ${SETTING_NAMES.length === 1 ? "is" : "are"}: ${SETTING_NAMES.join(", ")})`);
  return SETTINGS[key];
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

const assignment = (line) => /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);

// The value of one setting: what the file says, or the default. A value the
// file holds but that makes no sense is an error naming the file, not a
// silent fall back to the default.
export function getSetting(key, file = configPath()) {
  const setting = known(key);
  let found;
  for (const line of readLines(file)) {
    const match = assignment(line);
    if (match?.[1] === key) found = match[2]; // the last one wins, as in a shell
  }
  if (found === undefined) return setting.fallback;
  try {
    return setting.parse(found);
  } catch (err) {
    throw new Error(`${file}: ${key}: ${err.message}`, { cause: err });
  }
}

// Changes one setting and leaves every other line, comments included, as it was.
export function setSetting(key, value, file = configPath()) {
  const parsed = known(key).parse(String(value));
  const lines = readLines(file).filter((line) => assignment(line)?.[1] !== key);
  while (lines.length && lines.at(-1) === "") lines.pop();
  lines.push(`${key}=${parsed}`, "");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  return parsed;
}

// The port the Tapestry is served on: what was asked for on the command
// line, else EVENTLOOM_TAPESTRY_PORT, else the setting, else 4747.
export function tapestryPort({ flag, env = process.env, file = configPath(env) } = {}) {
  if (flag !== undefined) return port(String(flag), { lowest: 1 });
  if (env.EVENTLOOM_TAPESTRY_PORT) {
    try {
      return port(env.EVENTLOOM_TAPESTRY_PORT, { lowest: 1 });
    } catch (err) {
      throw new Error(`EVENTLOOM_TAPESTRY_PORT: ${err.message}`, { cause: err });
    }
  }
  return getSetting("tapestry_port", file);
}

export function describeSettings(file = configPath()) {
  return SETTING_NAMES.map((key) => `${key}=${getSetting(key, file)}  # ${SETTINGS[key].about}`);
}
