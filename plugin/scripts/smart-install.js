#!/usr/bin/env node
/**
 * smart-install.js — graphiti-mem dependency installer
 *
 * Checks whether the Python virtual environment with all graphiti-mem
 * dependencies exists. If not, creates it using `uv` and installs
 * requirements from requirements.txt.
 *
 * Exit codes:
 *   0 — dependencies are ready
 *   1 — installation failed
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, "..");
const REQUIREMENTS = path.join(PLUGIN_ROOT, "scripts", "requirements.txt");
const VENV_DIR = path.join(os.homedir(), ".graphiti-mem", "venv");
const MARKER = path.join(VENV_DIR, ".installed");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`graphiti-mem: ${msg}\n`);
}

function runFile(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    timeout: 120_000,
    ...opts,
  });
}

function commandExists(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function findUv() {
  // Check PATH first
  if (commandExists("uv")) return "uv";

  // Check common install locations
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "uv"),
    path.join(os.homedir(), ".cargo", "bin", "uv"),
    "/usr/local/bin/uv",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function requirementsHash() {
  try {
    const content = fs.readFileSync(REQUIREMENTS, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // 1. Check requirements.txt exists
  if (!fs.existsSync(REQUIREMENTS)) {
    log(`ERROR: requirements.txt not found at ${REQUIREMENTS}`);
    process.exit(1);
  }

  // 2. Find uv binary
  let uvBin = findUv();

  if (!uvBin) {
    log("uv not found — installing...");
    try {
      // Use the official uv installer script via sh
      const installerUrl = "https://astral.sh/uv/install.sh";
      const installer = execFileSync("curl", ["-LsSf", installerUrl], {
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 30_000,
      });
      execFileSync("sh", ["-c", installer], {
        stdio: "inherit",
        timeout: 60_000,
      });
      uvBin = findUv();
      if (!uvBin) {
        log("ERROR: uv installation succeeded but binary not found");
        process.exit(1);
      }
      log("uv installed successfully");
    } catch (err) {
      log(`ERROR: Failed to install uv: ${err.message}`);
      process.exit(1);
    }
  }

  // 3. Compute requirements hash to detect changes
  const hash = requirementsHash();

  // 4. Check if venv exists and is up-to-date
  if (fs.existsSync(MARKER)) {
    const installedHash = fs.readFileSync(MARKER, "utf-8").trim();
    if (installedHash === hash) {
      log("dependencies ok");
      return;
    }
    log("requirements changed — reinstalling...");
  }

  // 5. Create venv if it doesn't exist
  const venvPython = path.join(VENV_DIR, "bin", "python");
  if (!fs.existsSync(venvPython)) {
    log("creating virtual environment...");
    fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
    try {
      runFile(uvBin, ["venv", VENV_DIR, "--python", "3.11"]);
    } catch {
      // Fallback: try without specifying python version
      try {
        runFile(uvBin, ["venv", VENV_DIR]);
      } catch (err) {
        log(`ERROR: Failed to create venv: ${err.message}`);
        process.exit(1);
      }
    }
  }

  // 6. Install dependencies
  log("installing dependencies...");
  try {
    runFile(uvBin, ["pip", "install", "--python", venvPython, "-r", REQUIREMENTS]);
  } catch (err) {
    log(`ERROR: Failed to install dependencies: ${err.message}`);
    process.exit(1);
  }

  // 7. Write marker with hash
  fs.writeFileSync(MARKER, hash, "utf-8");
  log("dependencies installed successfully");
}

main();
