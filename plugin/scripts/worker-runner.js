#!/usr/bin/env node
// worker-runner.js — Bridge between Claude Code Hooks and the Python Graphiti Worker
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// --- Configuration ---
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(process.env.HOME, '.claude/plugins/marketplaces/oliverbenns/plugin');
const WORKER_PORT = 37778;
const WORKER_URL = `http://localhost:${WORKER_PORT}`;
const DATA_DIR = path.join(process.env.HOME, '.graphiti-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');
const LOG_FILE = path.join(DATA_DIR, 'worker.log');
// Cross-platform: Windows uses Scripts\python, Unix uses bin/python
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(DATA_DIR, 'venv', 'Scripts', 'python.exe')
  : path.join(DATA_DIR, 'venv', 'bin', 'python');
const WORKER_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'worker-service.py');

// --- Project identification ---
const PROJECT_ID = crypto.createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8);
const PROJECT_NAME = path.basename(process.cwd());

// --- Ensure data directory exists ---
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// --- HTTP helpers ---
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, WORKER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function postToWorker(endpoint, body) {
  try {
    const result = await httpRequest('POST', endpoint, body);
    return result.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return null;
    throw err;
  }
}

async function getFromWorker(endpoint) {
  try {
    const result = await httpRequest('GET', endpoint);
    return result.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') return null;
    throw err;
  }
}

async function isWorkerRunning() {
  try {
    const result = await getFromWorker('/health');
    return result && result.status === 'ok';
  } catch {
    return false;
  }
}

// --- Worker lifecycle ---
async function startWorker() {
  if (await isWorkerRunning()) {
    return true;
  }

  // Check if venv python exists
  if (!fs.existsSync(VENV_PYTHON)) {
    console.error(`[graphiti-mem] Python venv not found at ${VENV_PYTHON}. Run installer first.`);
    return false;
  }

  // Resolve worker script path
  const scriptPath = fs.existsSync(WORKER_SCRIPT)
    ? WORKER_SCRIPT
    : path.join(DATA_DIR, 'worker-service.py');

  if (!fs.existsSync(scriptPath)) {
    console.error(`[graphiti-mem] Worker script not found at ${scriptPath}`);
    return false;
  }

  // Spawn the worker process
  const logStream = fs.openSync(LOG_FILE, 'a');
  const child = spawn(VENV_PYTHON, [scriptPath], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      GRAPHITI_MEM_PORT: String(WORKER_PORT),
      GRAPHITI_MEM_DATA_DIR: DATA_DIR,
    },
  });

  // Save PID
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  // Wait for worker to come online (max 15 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isWorkerRunning()) {
      return true;
    }
  }

  console.error('[graphiti-mem] Worker failed to start within 15 seconds');
  return false;
}

// --- Read STDIN (for hook data from Claude Code) ---
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('{}');
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data || '{}'));

    // Safety timeout: don't hang forever
    setTimeout(() => resolve(data || '{}'), 5000);
  });
}

// --- Format helpers ---
function formatFacts(facts) {
  if (!facts || facts.length === 0) return '';
  return facts.map((f) => {
    const ts = f.created_at ? ` (${new Date(f.created_at).toLocaleDateString('de-DE')})` : '';
    return `- ${f.fact || f.content || f.name || JSON.stringify(f)}${ts}`;
  }).join('\n');
}

function formatEntities(entities) {
  if (!entities || entities.length === 0) return '';
  return entities.map((e) => {
    const type = e.type ? ` [${e.type}]` : '';
    return `- **${e.name || e.label || 'Unbenannt'}**${type}: ${e.summary || e.description || ''}`;
  }).join('\n');
}

function formatTimeline(events) {
  if (!events || events.length === 0) return '';
  return events.map((ev) => {
    const date = ev.created_at ? new Date(ev.created_at).toLocaleDateString('de-DE') : '';
    return `- [${date}] ${ev.name || ev.content || ev.summary || ''}`;
  }).join('\n');
}

// --- Main command dispatch ---
async function main() {
  const args = process.argv.slice(2);
  const command = args.join(' ').trim();

  switch (command) {
    // =============================
    // START — launch worker if needed
    // =============================
    case 'start': {
      const ok = await startWorker();
      if (ok) {
        console.error('[graphiti-mem] Worker running on port ' + WORKER_PORT);
      } else {
        console.error('[graphiti-mem] Could not start worker');
        process.exit(1);
      }
      break;
    }

    // =============================
    // HOOK: CONTEXT — retrieve remembered context for system-reminder
    // =============================
    case 'hook context': {
      if (!(await isWorkerRunning())) break;

      try {
        // Search for project-specific context
        const searchResult = await postToWorker('/search', {
          project_id: PROJECT_ID,
          query: `${PROJECT_NAME} recent work entities decisions`,
          num_results: 15,
        });

        // Get entities for this project
        const entitiesResult = await postToWorker('/entities', {
          project_id: PROJECT_ID,
          limit: 10,
        });

        // Get recent timeline
        const timelineResult = await postToWorker('/timeline', {
          project_id: PROJECT_ID,
          limit: 8,
        });

        const facts = searchResult?.facts || searchResult?.results || [];
        const entities = entitiesResult?.entities || [];
        const timeline = timelineResult?.events || timelineResult?.timeline || [];

        // Only output if we have something to say
        if (facts.length > 0 || entities.length > 0 || timeline.length > 0) {
          const parts = [];
          parts.push('<system-reminder>');
          parts.push('# graphiti-mem: Kontext aus Wissensgraph');
          parts.push('');
          parts.push(`**Projekt:** ${PROJECT_NAME} (${PROJECT_ID})`);

          if (entities.length > 0) {
            parts.push('');
            parts.push('## Aktuelle Entitaeten');
            parts.push(formatEntities(entities));
          }

          if (facts.length > 0) {
            parts.push('');
            parts.push('## Relevante Fakten');
            parts.push(formatFacts(facts));
          }

          if (timeline.length > 0) {
            parts.push('');
            parts.push('## Letzte Aktivitaeten');
            parts.push(formatTimeline(timeline));
          }

          parts.push('</system-reminder>');
          console.log(parts.join('\n'));
        }
      } catch (err) {
        console.error(`[graphiti-mem] Context retrieval failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: SESSION-INIT — lightweight session check
    // =============================
    case 'hook session-init': {
      if (!(await isWorkerRunning())) {
        // Try to start worker if not running
        await startWorker();
      }

      try {
        await postToWorker('/session', {
          project_id: PROJECT_ID,
          project_name: PROJECT_NAME,
          action: 'init',
          cwd: process.cwd(),
        });
      } catch (err) {
        console.error(`[graphiti-mem] Session init failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: OBSERVATION — capture tool use data
    // =============================
    case 'hook observation': {
      if (!(await isWorkerRunning())) break;

      const stdinData = await readStdin();
      try {
        const hookData = JSON.parse(stdinData);
        const toolName = hookData.tool_name || hookData.tool || 'unknown';
        const toolInput = JSON.stringify(hookData.tool_input || hookData.input || {});
        const toolOutput = JSON.stringify(hookData.tool_response || hookData.output || hookData.result || {});

        // Skip noisy tools that don't carry meaningful context
        const skipTools = ['Bash', 'mcp__notify', 'mcp__plugin_chrome-devtools', 'mcp__plugin_playwright'];
        const skipPatterns = [/^Bash$/, /curl.*notify/, /^ToolSearch$/];

        const shouldSkip = skipTools.some((t) => toolName.startsWith(t))
          || skipPatterns.some((p) => p.test(toolName));

        if (shouldSkip) break;

        // Truncate overly large outputs to avoid overwhelming the graph
        const maxLen = 4000;
        const truncatedOutput = toolOutput.length > maxLen
          ? toolOutput.slice(0, maxLen) + '... [truncated]'
          : toolOutput;
        const truncatedInput = toolInput.length > maxLen
          ? toolInput.slice(0, maxLen) + '... [truncated]'
          : toolInput;

        await postToWorker('/episodes', {
          project_id: PROJECT_ID,
          name: `${toolName} in ${PROJECT_NAME}`,
          content: `Tool: ${toolName}\nInput: ${truncatedInput}\nOutput: ${truncatedOutput}`,
          source: 'tool_use',
          source_description: `${toolName} operation in project ${PROJECT_NAME}`,
        });
      } catch (err) {
        // Silently fail — observations are best-effort
        console.error(`[graphiti-mem] Observation capture failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: COMPACT — save compacted context before it's lost
    // Called from SessionStart with 'compact' matcher BEFORE context injection
    // =============================
    case 'hook compact': {
      if (!(await isWorkerRunning())) break;

      const stdinData = await readStdin();
      try {
        const hookData = JSON.parse(stdinData);
        // Claude Code provides the compact summary in various fields
        const compactText = hookData.summary
          || hookData.compact_summary
          || hookData.content
          || hookData.message
          || JSON.stringify(hookData);

        if (compactText && compactText !== '{}') {
          await postToWorker('/compact', {
            project_id: PROJECT_ID,
            project_name: PROJECT_NAME,
            compact_text: compactText,
          });
          console.error(`[graphiti-mem] Compact context saved (${compactText.length} chars)`);
        }
      } catch (err) {
        console.error(`[graphiti-mem] Compact hook failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: LEARN — NLP learning extraction at session end (Stop hook)
    // Extracts entities, relationships, facts, preferences from the full session
    // =============================
    case 'hook learn': {
      if (!(await isWorkerRunning())) break;

      const stdinData = await readStdin();
      try {
        const hookData = JSON.parse(stdinData);

        // Collect session summary from Stop hook data
        const summary = hookData.summary
          || hookData.content
          || hookData.message
          || hookData.stop_reason
          || 'Session completed';

        const toolCount = hookData.tool_use_count
          || hookData.tool_count
          || 0;

        await postToWorker('/learn', {
          project_id: PROJECT_ID,
          project_name: PROJECT_NAME,
          session_summary: summary,
          tool_count: toolCount,
          compact_context: '', // filled only when compact happened
        });
        console.error(`[graphiti-mem] NLP learning extraction complete for ${PROJECT_NAME}`);
      } catch (err) {
        console.error(`[graphiti-mem] Learning extraction failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: SUMMARIZE — lightweight stop summary (kept for backwards compat)
    // =============================
    case 'hook summarize': {
      if (!(await isWorkerRunning())) break;

      const stdinData = await readStdin();
      try {
        const hookData = JSON.parse(stdinData);
        const summary = hookData.summary || hookData.content || hookData.message || '';

        if (summary) {
          // Use the full NLP learning extraction endpoint
          await postToWorker('/learn', {
            project_id: PROJECT_ID,
            project_name: PROJECT_NAME,
            session_summary: summary,
            tool_count: 0,
            compact_context: '',
          });
        }
      } catch (err) {
        console.error(`[graphiti-mem] Summary/learn failed: ${err.message}`);
      }
      break;
    }

    // =============================
    // HOOK: SESSION-COMPLETE — mark session end
    // =============================
    case 'hook session-complete': {
      if (!(await isWorkerRunning())) break;

      try {
        await postToWorker('/session', {
          project_id: PROJECT_ID,
          project_name: PROJECT_NAME,
          action: 'complete',
          cwd: process.cwd(),
          completed_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[graphiti-mem] Session complete failed: ${err.message}`);
      }
      break;
    }

    default:
      console.error(`[graphiti-mem] Unknown command: "${command}"`);
      console.error('Usage: worker-runner.js <start|hook context|hook session-init|hook observation|hook compact|hook learn|hook summarize|hook session-complete>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[graphiti-mem] Fatal error: ${err.message}`);
  process.exit(1);
});
