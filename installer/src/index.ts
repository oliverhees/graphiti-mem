#!/usr/bin/env node
/**
 * graphiti-mem Installer
 * Zero-friction installation of the graphiti-mem Claude Code plugin.
 */
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const VERSION = '1.0.0';
const DATA_DIR = path.join(os.homedir(), '.graphiti-mem');
const VENV_DIR = path.join(DATA_DIR, 'venv');
const REQUIREMENTS = path.join(__dirname, '..', '..', 'plugin', 'scripts', 'requirements.txt');

const UV_EXTRA_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'uv'),
  path.join(os.homedir(), '.cargo', 'bin', 'uv'),
  '/usr/local/bin/uv',
];

function findBinary(name: string, extraPaths: string[] = []): string | null {
  try {
    const result = execFileSync('which', [name], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (result) return result;
  } catch {
    // not in PATH
  }
  for (const extra of extraPaths) {
    if (fs.existsSync(extra)) return extra;
  }
  return null;
}

/**
 * Install uv using the official installer script.
 * URL is hardcoded — not user-supplied — so shell execution is safe here.
 */
function installUvSafe(): string | null {
  try {
    p.log.step('Downloading and running uv installer (astral.sh/uv)...');
    // Download installer first, then execute via sh — both URLs are hardcoded constants
    const downloadResult = spawnSync('curl', ['-LsSf', 'https://astral.sh/uv/install.sh'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (downloadResult.status !== 0) return null;

    const runResult = spawnSync('sh', [], {
      input: downloadResult.stdout,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (runResult.status !== 0) return null;

    return findBinary('uv', UV_EXTRA_PATHS);
  } catch {
    return null;
  }
}

async function main() {
  console.clear();
  p.intro(
    pc.bgBlue(pc.white(' graphiti-mem ')) +
    pc.dim(` v${VERSION} — Temporal Knowledge Graph Memory for Claude Code`),
  );

  p.log.info('graphiti-mem captures everything Claude does and builds a persistent knowledge graph.');
  p.log.info('Context is preserved across compactions, restarts, and new sessions — permanently.');

  // Step 1: Node.js version check
  await p.tasks([
    {
      title: 'Checking Node.js',
      task: async () => {
        const version = process.version.slice(1);
        const [major] = version.split('.').map(Number);
        if (major >= 18) return `Node.js ${process.version} ${pc.green('✓')}`;
        throw new Error(`Node.js ${process.version} requires >= 18.0.0`);
      },
    },
  ]);

  // Step 2: Find or install uv
  let uvPath = findBinary('uv', UV_EXTRA_PATHS);

  if (!uvPath) {
    p.log.warn('uv (Python package manager) not found');
    const shouldInstall = await p.confirm({
      message: 'Install uv automatically? (required for graphiti-core)',
      initialValue: true,
    });

    if (!shouldInstall || p.isCancel(shouldInstall)) {
      p.log.error('uv is required. Install manually: https://docs.astral.sh/uv/');
      process.exit(1);
    }

    uvPath = installUvSafe();
    if (!uvPath) {
      p.log.error('Could not install uv. Please install manually: https://docs.astral.sh/uv/');
      process.exit(1);
    }
    p.log.success(`uv installed at ${uvPath}`);
  } else {
    p.log.success(`uv found at ${uvPath}`);
  }

  // Step 3: VOYAGE_API_KEY — required for semantic search (embeddings)
  // NLP extraction uses the claude CLI — no Anthropic API key needed.
  let voyageKey = process.env.VOYAGE_API_KEY;

  // Also check ~/.graphiti-mem/.env if already installed
  const dotEnvPath = path.join(DATA_DIR, '.env');
  if (!voyageKey && fs.existsSync(dotEnvPath)) {
    const lines = fs.readFileSync(dotEnvPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^VOYAGE_API_KEY=(.+)$/);
      if (m) { voyageKey = m[1].trim().replace(/^["']|["']$/g, ''); break; }
    }
  }

  if (!voyageKey) {
    p.log.warn('VOYAGE_API_KEY not set — needed for semantic search (embeddings)');
    p.log.info('Get a free key at: https://dash.voyageai.com/ (50M tokens/month free)');

    const keyInput = await p.text({
      message: 'Enter your VOYAGE_API_KEY (or leave blank to skip):',
      placeholder: 'pa-...',
    });

    if (p.isCancel(keyInput)) process.exit(0);

    if (keyInput && String(keyInput).trim()) {
      voyageKey = String(keyInput).trim();
    } else {
      p.log.warn('Skipping — set VOYAGE_API_KEY before first use.');
    }
  } else {
    p.log.success(`VOYAGE_API_KEY found (${voyageKey.slice(0, 6)}...)`);
  }

  // Step 4: Create venv and install dependencies
  await p.tasks([
    {
      title: 'Creating Python virtual environment (~/.graphiti-mem/venv)',
      task: async () => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        execFileSync(uvPath!, ['venv', VENV_DIR, '--python', '3.11'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return `venv created ${pc.green('✓')}`;
      },
    },
    {
      title: 'Installing graphiti-core[kuzu] + FastAPI + Uvicorn',
      task: async () => {
        const pythonInVenv = path.join(VENV_DIR, 'bin', 'python');
        execFileSync(uvPath!, ['pip', 'install', '-r', REQUIREMENTS, '--python', pythonInVenv], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300_000,
        });
        // Write install marker (hash of requirements)
        const reqHash = crypto
          .createHash('sha256')
          .update(fs.readFileSync(REQUIREMENTS))
          .digest('hex')
          .slice(0, 8);
        fs.writeFileSync(path.join(DATA_DIR, '.installed'), reqHash, 'utf8');
        return `Dependencies installed ${pc.green('✓')}`;
      },
    },
  ]);

  // Step 5: Write ~/.graphiti-mem/.env with the API key
  if (voyageKey) {
    let envContent = '';
    if (fs.existsSync(dotEnvPath)) {
      // Preserve existing lines, update VOYAGE_API_KEY
      envContent = fs.readFileSync(dotEnvPath, 'utf8')
        .split('\n')
        .filter(l => !l.startsWith('VOYAGE_API_KEY='))
        .join('\n');
      if (envContent && !envContent.endsWith('\n')) envContent += '\n';
    }
    envContent += `VOYAGE_API_KEY=${voyageKey}\n`;
    fs.writeFileSync(dotEnvPath, envContent, 'utf8');
    p.log.success(`VOYAGE_API_KEY saved to ${dotEnvPath}`);
  }

  // Step 6: Copy Python worker scripts to data dir
  const scriptsDir = path.resolve(__dirname, '..', '..', 'plugin', 'scripts');
  for (const script of ['worker-service.py', 'claude_code_llm_client.py']) {
    const src = path.join(scriptsDir, script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(DATA_DIR, script));
    }
  }
  p.log.success('Worker scripts deployed to ~/.graphiti-mem/');

  p.outro(
    pc.green('✓ graphiti-mem installed!\n\n') +
    pc.dim('Restart Claude Code to activate.\n\n') +
    pc.dim('graphiti-mem will automatically:\n') +
    pc.dim('  • Learn from every tool use via NLP entity extraction\n') +
    pc.dim('  • Preserve full context across session compactions\n') +
    pc.dim('  • Inject relevant knowledge at every session start\n') +
    pc.dim('  • Build a growing temporal knowledge graph per project\n'),
  );
}

main().catch((err) => {
  p.log.error(`Installation failed: ${(err as Error).message}`);
  process.exit(1);
});
