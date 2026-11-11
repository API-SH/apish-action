// The few runner commands this action needs (inputs, outputs, masking, errors, job summary), per
// https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";

export function getInput(name, env = process.env) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "").trim();
}

const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function setSecret(value) {
  process.stdout.write(`::add-mask::${escapeData(value)}${EOL}`);
}

export function info(message) {
  process.stdout.write(`${message}${EOL}`);
}

export function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  const text = String(value ?? "");
  if (!file) return; // not on a runner
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${text}${EOL}${delimiter}${EOL}`);
}

export function summary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown + EOL);
}

export function setFailed(message) {
  process.exitCode = 1;
  process.stdout.write(`::error::${escapeData(message)}${EOL}`);
}
