import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { ApishError, callApi } from "./client.js";

const exec = promisify(execFile);
const META = ["success", "cached", "fetched_at", "credits_used", "request_id"];
const OUTPUTS = new Set(["json", "csv", "ndjson"]);

/** "username: nasa" or '{"username": "nasa"}' -> { username: "nasa" }. Lists become comma-separated values. */
export function parseParams(text) {
  if (!text || !text.trim()) return {};
  let value;
  try {
    value = parseYaml(text); // YAML is a superset of JSON
  } catch (err) {
    throw new Error(`params is not valid YAML or JSON: ${err.message}`);
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error('params must be a mapping, e.g. "username: nasa"');
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) throw new Error(`params.${k} must be a single value or a list`);
    out[k] = Array.isArray(v) ? v.join(",") : String(v);
  }
  return out;
}

export function bool(value, name) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off", ""].includes(v)) return false;
  throw new Error(`${name} must be true or false (got "${value}")`);
}

/** /google/v1/search -> data/google-search.json */
export function defaultPath(route, output) {
  const segs = route.split("/").filter(Boolean).filter((s) => s !== "v1");
  return `data/${segs.join("-").replace(/[^a-zA-Z0-9._-]+/g, "-") || "snapshot"}.${output}`;
}

/** Leaves call metadata out of a JSON response, so the file only changes when the data does. */
export function stripMeta(text) {
  const data = JSON.parse(text);
  if (data && typeof data === "object" && !Array.isArray(data)) for (const k of META) delete data[k];
  return JSON.stringify(data, null, 2) + "\n";
}

/**
 * Calls the endpoint, writes the file, and commits it when asked and changed.
 * `inputs` uses the action.yml names; returns the action outputs.
 */
export async function snapshot(inputs, { fetch, log = () => {}, cwd = process.cwd(), env = process.env, retryDelayMs } = {}) {
  const apiKey = (inputs["api-key"] || "").trim();
  if (!apiKey) throw new Error("api-key is empty. Add your key as a repository secret and pass api-key: ${{ secrets.APISH_API_KEY }}");
  const route = (inputs.route || "").trim();
  if (!/^\/?[a-z0-9-]+\/v\d+\//i.test(route) && !route.startsWith("/v1/")) throw new Error(`route should look like /tiktok/v1/profile (got "${route}")`);
  const output = (inputs.output || "json").trim().toLowerCase();
  if (!OUTPUTS.has(output)) throw new Error(`output must be json, csv or ndjson (got "${inputs.output}")`);
  const path = (inputs.path || "").trim() || defaultPath(route, output);

  const params = parseParams(inputs.params);
  params.raw = bool(inputs.raw, "raw") ? "1" : "0";
  if (bool(inputs.fresh, "fresh")) params.fresh = "1";
  if (inputs.fields?.trim()) params.fields = inputs.fields.trim();
  if (output !== "json") {
    params.output = output;
    if (inputs.records?.trim()) params.records = inputs.records.trim();
  }

  log(`GET ${route} ${JSON.stringify({ ...params })}`);
  const { text, meta } = await callApi({ baseUrl: inputs["base-url"] || "https://api.api.sh", apiKey, route, params, fetch, ...(retryDelayMs !== undefined ? { backoffMs: retryDelayMs } : {}) });
  const body = output === "json" && bool(inputs["strip-meta"] ?? "true", "strip-meta") ? stripMeta(text) : output === "json" ? prettyJson(text) : text;

  const file = resolveIn(cwd, path);
  const before = await readFile(file, "utf8").catch(() => null);
  const changed = before !== body;
  if (changed) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  log(`${changed ? "Wrote" : "No change to"} ${path} (request ${meta.requestId || "-"}, credits ${meta.credits || "0"})`);

  let committed = false;
  if (bool(inputs.commit, "commit") && changed) {
    committed = await commitFile({
      cwd, path, env, log,
      message: (inputs["commit-message"] || "Update {path} from api.sh {route}").replaceAll("{path}", path).replaceAll("{route}", route),
      name: inputs["author-name"] || "github-actions[bot]",
      email: inputs["author-email"] || "41898282+github-actions[bot]@users.noreply.github.com",
    });
  }
  return { path, changed: String(changed), committed: String(committed), credits: meta.credits, "credits-remaining": meta.creditsRemaining, "request-id": meta.requestId };
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2) + "\n";
  } catch {
    return text;
  }
}

function resolveIn(cwd, path) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) ? path : `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

async function git(cwd, ...args) {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

/** Commits the file as the given author and pushes to the current branch (one rebase retry if the push races). */
export async function commitFile({ cwd, path, message, name, email, env = process.env, log = () => {} }) {
  await git(cwd, "add", "--", path);
  if (!(await git(cwd, "status", "--porcelain", "--", path))) return false;
  await git(cwd, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message, "--", path);
  const branch = env.GITHUB_HEAD_REF || (env.GITHUB_REF?.startsWith("refs/heads/") ? env.GITHUB_REF.slice(11) : "") || (await git(cwd, "rev-parse", "--abbrev-ref", "HEAD"));
  if (!branch || branch === "HEAD") throw new Error("cannot commit: the checkout is not on a branch (run on a branch, not a tag)");
  const remote = (await git(cwd, "remote")).split("\n")[0];
  if (!remote) {
    log("Committed (no git remote to push to)");
    return true;
  }
  try {
    await git(cwd, "push", remote, `HEAD:refs/heads/${branch}`);
  } catch {
    log("Push was rejected; rebasing on the remote branch and trying once more");
    await git(cwd, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "pull", "--rebase", remote, branch);
    await git(cwd, "push", remote, `HEAD:refs/heads/${branch}`);
  }
  log(`Committed and pushed ${path} to ${branch}`);
  return true;
}

export { ApishError };
