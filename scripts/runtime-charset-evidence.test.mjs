import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  charsetEnvironmentNames, maximumCharsetEnvironmentBytes, observeRuntimeCharsetEvidence,
  projectRuntimeCharsetEvidence, projectStartupCharsetEnvironment, readStartupCharsetEnvironment, runtimeCharsetProbeSource,
} from "./runtime-charset-evidence.mjs";

const secret = "SECRET_CHARSET_ENVIRONMENT_AND_ERROR_MUST_STAY_LOCAL";
const bytes = entries => Buffer.from(entries.length ? entries.join("\0") + "\0" : "");
function fixtureIo(input, chunk = input.length || 1) {
  let position = 0, requested = 0, closed = false;
  return {
    openSync(path, flags) { assert.equal(path, "/proc/1/environ"); assert.equal(flags, "r"); return 42; },
    readSync(descriptor, output, offset, length, filePosition) {
      assert.equal(descriptor, 42); assert.equal(filePosition, null);
      assert.ok(offset + length <= maximumCharsetEnvironmentBytes);
      requested = Math.max(requested, offset + length);
      const count = Math.min(chunk, length, input.length - position);
      input.copy(output, offset, position, position + count); position += count; return count;
    },
    closeSync(descriptor) { assert.equal(descriptor, 42); closed = true; },
    state: () => ({ position, requested, closed }),
  };
}
function observation(environment = {}, startup = []) {
  return observeRuntimeCharsetEvidence({ environment, io: fixtureIo(bytes(startup), 7) });
}
function privateResult(input) {
  const text = JSON.stringify(input);
  assert.ok(!text.includes(secret)); assert.ok(!text.includes("sha256"));
  assert.ok(!text.includes("error")); return input;
}
test("PID 1 startup region and fresh exec selected environment remain separately identified", () => {
  const input = observation({ LANG: "C.UTF-8", LC_ALL: "", CHARSET: "UTF-8", GCONV_PATH: `/private/${secret}`,
    LOCPATH: "C", LIBCHARSET_ALIAS_DIR: secret, G_BROKEN_FILENAMES: "1", UNKNOWN: secret },
  ["LANG=ja_JP.UTF-8", "LANGUAGE=en_US.UTF-8", "OUTPUT_CHARSET=SHIFT_JISX0213", `TOKEN=${secret}`]);
  assert.equal(input.pid1StartupEnvironment.source, "/proc/1/environ-startup-region");
  assert.equal(input.execProbeEnvironment.source, "fresh-docker-exec-node-process.env");
  assert.equal(input.pid1StartupEnvironment.readLimitBytes, 65536);
  assert.deepEqual(input.pid1StartupEnvironment.variables.LANG, { status: "recognized", value: "ja_JP.UTF-8" });
  assert.deepEqual(input.execProbeEnvironment.variables.LANG, { status: "recognized", value: "C.UTF-8" });
  assert.deepEqual(input.execProbeEnvironment.variables.LC_ALL, { status: "empty" });
  assert.deepEqual(input.execProbeEnvironment.variables.LC_MESSAGES, { status: "unset" });
  for (const name of ["GCONV_PATH", "LOCPATH", "LIBCHARSET_ALIAS_DIR", "G_BROKEN_FILENAMES"]) {
    assert.deepEqual(input.execProbeEnvironment.variables[name], { status: "other" });
  }
  assert.deepEqual(input.nativeState, { processLocale: "not-observed", threadLocales: "not-observed", glibCharset: "not-observed" });
  assert.deepEqual(projectRuntimeCharsetEvidence(input), input); privateResult(input);
});
test("only a tiny fixed token set is recognized; compound and arbitrary locale values stay private", () => {
  const input = observation({ LANG: secret, LANGUAGE: "C:ja_JP.UTF-8", LC_CTYPE: "ja_JP.SJIS", CHARSET: "EUC-JISX0213",
    G_FILENAME_ENCODING: "@locale", OUTPUT_CHARSET: "UTF-8,ASCII", GCONV_PATH: "", LOCPATH: "", LIBCHARSET_ALIAS_DIR: "" });
  for (const name of ["LANG", "LANGUAGE", "LC_CTYPE", "OUTPUT_CHARSET"]) assert.deepEqual(input.execProbeEnvironment.variables[name], { status: "other" });
  assert.deepEqual(input.execProbeEnvironment.variables.CHARSET, { status: "recognized", value: "EUC-JISX0213" });
  assert.deepEqual(input.execProbeEnvironment.variables.G_FILENAME_ENCODING, { status: "recognized", value: "@locale" });
  for (const name of ["GCONV_PATH", "LOCPATH", "LIBCHARSET_ALIAS_DIR"]) assert.deepEqual(input.execProbeEnvironment.variables[name], { status: "empty" });
  privateResult(input);
});
test("fresh exec capture accesses only allowlisted own variables", () => {
  const environment = Object.create({ LANG: secret });
  Object.defineProperty(environment, "UNKNOWN_SECRET", { get() { throw new Error(secret); } });
  const input = observation(environment);
  assert.equal(input.execProbeEnvironment.status, "recorded");
  assert.equal(input.execProbeEnvironment.variables.LANG.status, "unset"); privateResult(input);
  Object.defineProperty(environment, "LANG", { get() { throw new Error(secret); } });
  assert.equal(privateResult(observation(environment)).execProbeEnvironment.status, "unknown");
});
for (const entries of [["LANG=C", "LANG=C"], ["UNKNOWN=a", "UNKNOWN=b"], ["LANG=C", "LANG=ja_JP.UTF-8"]]) {
  test(`duplicate startup variable invalidates all claims: ${entries[0].split("=")[0]} ${entries.length}`, () => {
    const input = projectStartupCharsetEnvironment(bytes([...entries, `SECRET=${secret}`]));
    assert.equal(input.status, "unknown"); assert.deepEqual(input.variables, {}); privateResult(input);
  });
}
for (const input of [Buffer.from("LANG=C"), bytes(["MALFORMED"]), bytes(["=C"]), bytes(["LANG=C", ""]), "not-a-buffer"]) {
  test(`malformed or truncated startup input is unknown: ${typeof input === "string" ? "type" : input.length}`, () => {
    assert.equal(privateResult(projectStartupCharsetEnvironment(input)).status, "unknown");
  });
}
test("chunked startup read is hard bounded, closes its descriptor and rejects filling the cap", () => {
  const input = Buffer.alloc(maximumCharsetEnvironmentBytes + 512, 120); Buffer.from("TOKEN=").copy(input); input[input.length - 1] = 0;
  const io = fixtureIo(input, 111);
  assert.equal(privateResult(readStartupCharsetEnvironment(io)).status, "unknown");
  assert.deepEqual(io.state(), { position: maximumCharsetEnvironmentBytes, requested: maximumCharsetEnvironmentBytes, closed: true });
  const exact = Buffer.alloc(maximumCharsetEnvironmentBytes, 120); Buffer.from("TOKEN=").copy(exact); exact[exact.length - 1] = 0;
  assert.equal(projectStartupCharsetEnvironment(exact).status, "unknown");
  const below = exact.subarray(0, exact.length - 1); below[below.length - 1] = 0;
  assert.equal(projectStartupCharsetEnvironment(below).status, "recorded");
});
test("a complete short read records only selected entries, including empty startup values", () => {
  const io = fixtureIo(bytes(["LANG=C", "LC_ALL=", `TOKEN=${secret}`]), 1);
  const input = readStartupCharsetEnvironment(io);
  assert.equal(input.status, "recorded"); assert.equal(io.state().closed, true);
  assert.deepEqual(Object.keys(input.variables), [...charsetEnvironmentNames]);
  assert.deepEqual(input.variables.LC_ALL, { status: "empty" }); privateResult(input);
});
for (const location of ["open", "read"]) test(`unreadable startup source is unknown without raw ${location} errors`, () => {
  let closed = false;
  const io = { openSync() { if (location === "open") throw new Error(secret); return 3; },
    readSync() { throw new Error(secret); }, closeSync() { closed = true; } };
  const input = observeRuntimeCharsetEvidence({ environment: { LANG: "C" }, io });
  assert.equal(input.pid1StartupEnvironment.status, "unknown"); assert.equal(input.execProbeEnvironment.status, "recorded");
  assert.equal(closed, location === "read"); privateResult(input);
});
test("missing and malformed projection sections are fixed unknown evidence", () => {
  const expected = projectRuntimeCharsetEvidence(undefined);
  assert.equal(expected.pid1StartupEnvironment.status, "unknown"); assert.equal(expected.execProbeEnvironment.status, "unknown");
  for (const mutate of [
    raw => { raw.secret = secret; }, raw => { raw.schema = 2; },
    raw => { raw.pid1StartupEnvironment.source = secret; }, raw => { raw.pid1StartupEnvironment.readLimitBytes++; },
    raw => { raw.execProbeEnvironment.variables.LANG = { status: "recognized", value: secret }; },
    raw => { raw.execProbeEnvironment.variables.GCONV_PATH = { status: "recognized", value: "C" }; },
    raw => { raw.execProbeEnvironment.variables.LANG = { status: "other", value: secret }; },
    raw => { raw.execProbeEnvironment.variables.LANG = { status: "empty", sha256: secret }; },
    raw => { delete raw.execProbeEnvironment.variables.LANG; },
    raw => { raw.execProbeEnvironment.variables.EXTRA = { status: "other" }; },
    raw => { raw.pid1StartupEnvironment.status = "unknown"; },
    raw => { raw.nativeState.glibCharset = "UTF-8"; }, raw => { raw.nativeState.secret = secret; },
  ]) {
    const raw = observation(); mutate(raw);
    assert.deepEqual(privateResult(projectRuntimeCharsetEvidence(raw)), expected);
  }
});
test("generated shell-free probe source runs independently and never serializes arbitrary environment", () => {
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `${runtimeCharsetProbeSource}\nconsole.log(JSON.stringify(observeRuntimeCharsetEvidence()));`],
    { encoding: "utf8", timeout: 10_000, env: { LANG: secret, CHARSET: "UTF-8", GCONV_PATH: `/private/${secret}`, TOKEN: secret } });
  const input = JSON.parse(result);
  assert.equal(input.execProbeEnvironment.status, "recorded");
  assert.equal(input.execProbeEnvironment.variables.LANG.status, "other");
  assert.deepEqual(input.execProbeEnvironment.variables.GCONV_PATH, { status: "other" });
  assert.deepEqual(projectRuntimeCharsetEvidence(input), input); privateResult(input);
});
