import * as core from "./core.js";
import { ApishError, snapshot } from "./snapshot.js";

const NAMES = ["api-key", "route", "params", "output", "path", "raw", "fields", "records", "fresh", "strip-meta", "commit", "commit-message", "author-name", "author-email", "base-url"];

async function main() {
  const inputs = Object.fromEntries(NAMES.map((n) => [n, core.getInput(n)]));
  if (inputs["api-key"]) core.setSecret(inputs["api-key"]);
  try {
    const out = await snapshot(inputs, { log: (m) => core.info(m), cwd: process.env.GITHUB_WORKSPACE || process.cwd() });
    for (const [k, v] of Object.entries(out)) core.setOutput(k, v ?? "");
    core.summary(`api.sh \`${inputs.route}\`: ${out.changed === "true" ? "updated" : "unchanged"} \`${out.path}\`${out.credits ? ` (${out.credits} credits)` : ""}`);
  } catch (err) {
    if (err instanceof ApishError) {
      const hint = {
        401: "Check the api-key secret (create a key at https://app.api.sh/keys).",
        402: "The account is out of credits or reached a spend limit (https://app.api.sh).",
        400: "Check route and params against the endpoint's docs (https://api.sh/docs).",
      }[err.status] || ([502, 503, 504].includes(err.status) ? "The source site did not answer; failed calls are free. The next scheduled run will try again." : "");
      core.setFailed(`api.sh: ${err.message} (HTTP ${err.status}${err.requestId ? `, request ${err.requestId}` : ""}). ${hint}`.trim());
    } else {
      core.setFailed(err.message || String(err));
    }
  }
}

main();
