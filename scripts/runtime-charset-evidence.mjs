import { closeSync, openSync, readSync } from "node:fs";

export const maximumCharsetEnvironmentBytes = 64 * 1024;
export const charsetEnvironmentNames = Object.freeze([
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "CHARSET",
  "G_FILENAME_ENCODING", "G_BROKEN_FILENAMES", "OUTPUT_CHARSET",
  "GCONV_PATH", "LOCPATH", "LIBCHARSET_ALIAS_DIR",
]);
const localeNames = ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES"];
const localeTokens = ["C", "POSIX", "C.UTF-8", "C.utf8", "en_US.UTF-8", "ja_JP.UTF-8"];
const encodingTokens = ["UTF-8", "UTF8", "ASCII", "US-ASCII", "EUC-JP", "EUC-JISX0213", "SHIFT_JIS", "SHIFT_JISX0213"];
const presenceOnlyNames = ["G_BROKEN_FILENAMES", "GCONV_PATH", "LOCPATH", "LIBCHARSET_ALIAS_DIR"];
const pid1Source = "/proc/1/environ-startup-region";
const execSource = "fresh-docker-exec-node-process.env";

function allowedTokens(name) {
  if (presenceOnlyNames.includes(name)) return [];
  if (localeNames.includes(name)) return localeTokens;
  return name === "G_FILENAME_ENCODING" ? [...encodingTokens, "@locale"] : encodingTokens;
}
function classifyCharsetValue(name, value) {
  if (value === undefined) return { status: "unset" };
  if (value === "") return { status: "empty" };
  return allowedTokens(name).includes(value) ? { status: "recognized", value } : { status: "other" };
}
function unknownCharsetSource(source) {
  return { source, status: "unknown", ...(source === pid1Source ? { readLimitBytes: maximumCharsetEnvironmentBytes } : {}), variables: {} };
}
function selectedCharsetEnvironment(environment, source) {
  try {
    const variables = {};
    for (const name of charsetEnvironmentNames) {
      const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
      if (value !== undefined && typeof value !== "string") return unknownCharsetSource(source);
      variables[name] = classifyCharsetValue(name, value);
    }
    return { source, status: "recorded", ...(source === pid1Source ? { readLimitBytes: maximumCharsetEnvironmentBytes } : {}), variables };
  } catch { return unknownCharsetSource(source); }
}

// Never decode or return the full environment. Invalid, duplicate or possibly
// truncated input invalidates this whole observation, including unset claims.
export function projectStartupCharsetEnvironment(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length >= maximumCharsetEnvironmentBytes ||
      (bytes.length !== 0 && bytes[bytes.length - 1] !== 0)) return unknownCharsetSource(pid1Source);
  const selected = Object.create(null), seen = new Set();
  let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 0) continue;
    const entry = bytes.subarray(start, end), separator = entry.indexOf(61);
    if (separator <= 0) return unknownCharsetSource(pid1Source);
    // A lossless name key also detects duplicate non-UTF-8 names, without
    // treating any arbitrary name or value as publishable evidence.
    const key = entry.subarray(0, separator).toString("hex");
    if (seen.has(key)) return unknownCharsetSource(pid1Source);
    seen.add(key);
    for (const name of charsetEnvironmentNames) if (entry.subarray(0, separator).equals(Buffer.from(name))) {
      selected[name] = entry.subarray(separator + 1).toString("utf8");
      break;
    }
    start = end + 1;
  }
  return selectedCharsetEnvironment(selected, pid1Source);
}

export function readStartupCharsetEnvironment(io = { openSync, readSync, closeSync }) {
  let descriptor;
  try {
    descriptor = io.openSync("/proc/1/environ", "r");
    const bytes = Buffer.alloc(maximumCharsetEnvironmentBytes);
    let size = 0;
    while (size < bytes.length) {
      const count = io.readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length - size) return unknownCharsetSource(pid1Source);
      if (count === 0) return projectStartupCharsetEnvironment(bytes.subarray(0, size));
      size += count;
    }
    // Filling the cap is ambiguous even when its final byte happens to be NUL.
    return unknownCharsetSource(pid1Source);
  } catch { return unknownCharsetSource(pid1Source); }
  finally { if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch { /* No raw IO errors. */ } } }
}
function nativeCharsetState() {
  return { processLocale: "not-observed", threadLocales: "not-observed", glibCharset: "not-observed" };
}
export function observeRuntimeCharsetEvidence({ environment = process.env, io } = {}) {
  return { schema: 1, pid1StartupEnvironment: readStartupCharsetEnvironment(io),
    execProbeEnvironment: selectedCharsetEnvironment(environment, execSource), nativeState: nativeCharsetState() };
}
function unknownRuntimeCharsetEvidence() {
  return { schema: 1, pid1StartupEnvironment: unknownCharsetSource(pid1Source),
    execProbeEnvironment: unknownCharsetSource(execSource), nativeState: nativeCharsetState() };
}
function exactKeys(input, names) {
  return input !== null && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === names.length && names.every(name => Object.hasOwn(input, name));
}
function validateCharsetSource(input, source) {
  if (!exactKeys(input, ["source", "status", "variables", ...(source === pid1Source ? ["readLimitBytes"] : [])]) ||
      input.source !== source || (source === pid1Source && input.readLimitBytes !== maximumCharsetEnvironmentBytes)) return false;
  if (input.status === "unknown") return exactKeys(input.variables, []);
  if (input.status !== "recorded" || !exactKeys(input.variables, charsetEnvironmentNames)) return false;
  for (const name of charsetEnvironmentNames) {
    const entry = input.variables[name];
    if (entry?.status === "recognized") {
      if (!exactKeys(entry, ["status", "value"]) || !allowedTokens(name).includes(entry.value)) return false;
    } else if (!exactKeys(entry, ["status"]) || !["unset", "empty", "other"].includes(entry.status)) return false;
  }
  return true;
}

// This is an optional evidence projection, never a new acceptance or safety
// gate. Old reports and unsafe new sections retain an explicit unknown result.
export function projectRuntimeCharsetEvidence(input) {
  try {
    if (!exactKeys(input, ["schema", "pid1StartupEnvironment", "execProbeEnvironment", "nativeState"]) || input.schema !== 1 ||
        !validateCharsetSource(input.pid1StartupEnvironment, pid1Source) || !validateCharsetSource(input.execProbeEnvironment, execSource) ||
        !exactKeys(input.nativeState, ["processLocale", "threadLocales", "glibCharset"]) ||
        !Object.values(input.nativeState).every(value => value === "not-observed")) return unknownRuntimeCharsetEvidence();
    // Rebuild every field; do not forward even a validated input object.
    const project = raw => ({ source: raw.source, status: raw.status,
      ...(raw.source === pid1Source ? { readLimitBytes: maximumCharsetEnvironmentBytes } : {}),
      variables: raw.status === "unknown" ? {} : Object.fromEntries(charsetEnvironmentNames.map(name => {
        const entry = raw.variables[name];
        return [name, entry.status === "recognized" ? { status: entry.status, value: entry.value } : { status: entry.status }];
      })) });
    return { schema: 1, pid1StartupEnvironment: project(input.pid1StartupEnvironment),
      execProbeEnvironment: project(input.execProbeEnvironment), nativeState: nativeCharsetState() };
  } catch { return unknownRuntimeCharsetEvidence(); }
}

// Embed the same trusted helper in a shell-free docker-exec Node probe. The
// generated source contains only fixed configuration, never observed values.
export const runtimeCharsetProbeSource = [
  'import { closeSync, openSync, readSync } from "node:fs";',
  `const maximumCharsetEnvironmentBytes = ${maximumCharsetEnvironmentBytes};`,
  ...Object.entries({ charsetEnvironmentNames, localeNames, localeTokens, encodingTokens, presenceOnlyNames, pid1Source, execSource })
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`),
  ...[allowedTokens, classifyCharsetValue, unknownCharsetSource, selectedCharsetEnvironment, projectStartupCharsetEnvironment,
    readStartupCharsetEnvironment, nativeCharsetState, observeRuntimeCharsetEvidence].map(operation => operation.toString()),
].join("\n");
