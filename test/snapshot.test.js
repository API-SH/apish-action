import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bool, defaultPath, parseParams, snapshot, stripMeta } from "../src/snapshot.js";
import { ApishError } from "../src/client.js";

const exec = promisify(execFile);
const tmp = (p) => mkdtemp(join(tmpdir(), p));

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: new URL(String(url)), headers: init.headers }); return handler(new URL(String(url)), calls.length); };
  return { fetch, calls };
}

const base = { "api-key": "ash_test", route: "/tiktok/v1/profile", params: "username: nasa", output: "json" };

test("params: YAML, JSON, lists and errors", () => {
  assert.deepEqual(parseParams("username: nasa\ncount: 20"), { username: "nasa", count: "20" });
  assert.deepEqual(parseParams('{"q": "running shoes", "country": "us"}'), { q: "running shoes", country: "us" });
  assert.deepEqual(parseParams("ids: [1, 2, 3]"), { ids: "1,2,3" });
  assert.deepEqual(parseParams(""), {});
  assert.throws(() => parseParams("- a\n- b"), /mapping/);
  assert.throws(() => parseParams("a: {b: 1}"), /single value/);
});

test("helpers", () => {
  assert.equal(defaultPath("/zillow/v1/search", "csv"), "data/zillow-search.csv");
  assert.equal(defaultPath("/github/v1/repository/issues", "json"), "data/github-repository-issues.json");
  assert.equal(bool("TRUE", "x"), true);
  assert.equal(bool("", "x"), false);
  assert.throws(() => bool("maybe", "commit"), /commit must be true or false/);
  assert.equal(stripMeta('{"success":true,"fetched_at":"t","cached":false,"credits_used":1,"username":"nasa"}'), '{\n  "username": "nasa"\n}\n');
});

test("writes a JSON snapshot, then reports no change on identical data", async () => {
  const cwd = await tmp("apish-action-");
  let n = 0;
  const api = fakeFetch(() => json({ success: true, fetched_at: `t${++n}`, username: "nasa", followers: 100 }, 200, { "x-credits-used": "1", "x-credits-remaining": "41", "x-request-id": "req_1" }));
  const out = await snapshot(base, { fetch: api.fetch, cwd });
  assert.deepEqual(out, { path: "data/tiktok-profile.json", changed: "true", committed: "false", credits: "1", "credits-remaining": "41", "request-id": "req_1" });
  const url = api.calls[0].url;
  assert.equal(url.pathname, "/tiktok/v1/profile");
  assert.equal(url.searchParams.get("username"), "nasa");
  assert.equal(url.searchParams.get("raw"), "0");
  assert.equal(api.calls[0].headers["x-api-key"], "ash_test");
  assert.deepEqual(JSON.parse(await readFile(join(cwd, "data/tiktok-profile.json"), "utf8")), { username: "nasa", followers: 100 });
  const again = await snapshot(base, { fetch: api.fetch, cwd });
  assert.equal(again.changed, "false"); // fetched_at differs, data does not
});

test("csv output asks the API for CSV and writes it as is", async () => {
  const cwd = await tmp("apish-action-");
  const api = fakeFetch(() => new Response("zpid,price\r\n1,500000\r\n", { headers: { "content-type": "text/csv" } }));
  const out = await snapshot({ ...base, route: "/zillow/v1/search", params: '{"location": "78704"}', output: "csv", path: "homes/78704.csv", records: "results" }, { fetch: api.fetch, cwd });
  assert.equal(out.path, "homes/78704.csv");
  assert.equal(api.calls[0].url.searchParams.get("output"), "csv");
  assert.equal(api.calls[0].url.searchParams.get("records"), "results");
  assert.equal(await readFile(join(cwd, "homes/78704.csv"), "utf8"), "zpid,price\r\n1,500000\r\n");
});

test("input errors are caught before any call", async () => {
  const api = fakeFetch(() => json({}));
  await assert.rejects(snapshot({ ...base, "api-key": "" }, { fetch: api.fetch }), /api-key is empty/);
  await assert.rejects(snapshot({ ...base, route: "tiktok profile" }, { fetch: api.fetch }), /route should look like/);
  await assert.rejects(snapshot({ ...base, output: "xml" }, { fetch: api.fetch }), /output must be/);
  assert.equal(api.calls.length, 0);
});

test("API errors: 401 fails at once, 502 is retried", async () => {
  let api = fakeFetch(() => json({ error: "invalid api key" }, 401, { "x-request-id": "req_x" }));
  await assert.rejects(snapshot(base, { fetch: api.fetch, cwd: await tmp("a-") }), (e) => e instanceof ApishError && e.status === 401 && e.requestId === "req_x");
  assert.equal(api.calls.length, 1);
  api = fakeFetch((_, n) => (n < 3 ? json({ error: "source failed" }, 502) : json({ username: "nasa" })));
  const out = await snapshot(base, { fetch: api.fetch, cwd: await tmp("a-"), retryDelayMs: 1 });
  assert.equal(out.changed, "true");
  assert.equal(api.calls.length, 3);
});

async function gitRepo() {
  const remote = await tmp("apish-remote-");
  await exec("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const cwd = await tmp("apish-work-");
  await exec("git", ["init", "-q", "-b", "main", cwd]);
  const g = (...a) => exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd });
  await writeFile(join(cwd, "README.md"), "x\n");
  await g("add", ".");
  await g("commit", "-q", "-m", "init");
  await g("remote", "add", "origin", remote);
  await g("push", "-q", "origin", "main");
  return { cwd, remote };
}

test("commit: true commits and pushes only when the file changed", async () => {
  const { cwd, remote } = await gitRepo();
  const api = fakeFetch(() => json({ username: "nasa", followers: 100 }));
  const env = { GITHUB_REF: "refs/heads/main" };
  const out = await snapshot({ ...base, commit: "true", "author-name": "Snapshot Bot", "author-email": "bot@example.com" }, { fetch: api.fetch, cwd, env });
  assert.equal(out.committed, "true");
  const { stdout } = await exec("git", ["log", "-1", "--format=%an <%ae>|%s", "main"], { cwd: remote });
  assert.equal(stdout.trim(), "Snapshot Bot <bot@example.com>|Update data/tiktok-profile.json from api.sh /tiktok/v1/profile");
  const again = await snapshot({ ...base, commit: "true" }, { fetch: api.fetch, cwd, env });
  assert.equal(again.committed, "false");
});

test("the bundled dist/index.js runs as the action", async () => {
  const server = createServer((req, res) => {
    if (req.headers["x-api-key"] !== "ash_test") { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"invalid api key"}'); }
    res.writeHead(200, { "content-type": "application/json", "x-credits-used": "1", "x-request-id": "req_dist" });
    res.end(JSON.stringify({ success: true, username: new URL(req.url, "http://x").searchParams.get("username") }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const cwd = await tmp("apish-dist-");
    const outputFile = join(cwd, "github_output");
    await writeFile(outputFile, "");
    const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const env = {
      ...process.env, GITHUB_WORKSPACE: cwd, GITHUB_OUTPUT: outputFile,
      "INPUT_API-KEY": "ash_test", INPUT_ROUTE: "/tiktok/v1/profile", INPUT_PARAMS: "username: nasa", INPUT_OUTPUT: "json",
      INPUT_PATH: "", INPUT_RAW: "false", INPUT_FRESH: "false", "INPUT_STRIP-META": "true", INPUT_COMMIT: "false",
      "INPUT_BASE-URL": `http://127.0.0.1:${server.address().port}`,
    };
    await exec(process.execPath, [dist], { env, cwd });
    assert.deepEqual(JSON.parse(await readFile(join(cwd, "data/tiktok-profile.json"), "utf8")), { username: "nasa" });
    const outputs = await readFile(outputFile, "utf8");
    assert.match(outputs, /changed<<[^\n]+\ntrue/);
    assert.match(outputs, /request-id<<[^\n]+\nreq_dist/);
    const bad = await exec(process.execPath, [dist], { env: { ...env, "INPUT_API-KEY": "wrong" }, cwd }).then(() => null, (e) => e);
    assert.ok(bad, "a bad key fails the step");
    assert.match(bad.stdout, /::error::api.sh: invalid api key \(HTTP 401\)/);
  } finally {
    server.close();
  }
});
