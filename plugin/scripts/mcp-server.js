#!/usr/bin/env node
// mcp-server.js — MCP Server for graphiti-mem knowledge graph access
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

// --- Configuration ---
const WORKER_PORT = 37778;
const WORKER_URL = `http://localhost:${WORKER_PORT}`;
const PROJECT_ID = crypto.createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8);
const PROJECT_NAME = path.basename(process.cwd());

// --- HTTP helper ---
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, WORKER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
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

// --- Format helpers ---
function formatFacts(facts) {
  if (!facts || facts.length === 0) return 'Keine Ergebnisse gefunden.';
  return facts.map((f, i) => {
    const ts = f.created_at ? ` (${new Date(f.created_at).toLocaleDateString('de-DE')})` : '';
    const score = f.score ? ` [Relevanz: ${(f.score * 100).toFixed(0)}%]` : '';
    return `${i + 1}. ${f.fact || f.content || f.name || JSON.stringify(f)}${ts}${score}`;
  }).join('\n');
}

function formatEntities(entities) {
  if (!entities || entities.length === 0) return 'Keine Entitaeten gefunden.';
  return entities.map((e, i) => {
    const type = e.type ? ` [${e.type}]` : '';
    const desc = e.summary || e.description || 'Keine Beschreibung';
    const created = e.created_at ? ` | Erstellt: ${new Date(e.created_at).toLocaleDateString('de-DE')}` : '';
    return `${i + 1}. **${e.name || e.label || 'Unbenannt'}**${type}\n   ${desc}${created}`;
  }).join('\n\n');
}

function formatRelationships(rels) {
  if (!rels || rels.length === 0) return 'Keine Beziehungen gefunden.';
  return rels.map((r, i) => {
    const source = r.source_name || r.source || '?';
    const target = r.target_name || r.target || '?';
    const type = r.type || r.relation || 'related_to';
    const fact = r.fact || r.description || '';
    return `${i + 1}. ${source} --[${type}]--> ${target}${fact ? '\n   ' + fact : ''}`;
  }).join('\n');
}

function formatTimeline(events) {
  if (!events || events.length === 0) return 'Keine Aktivitaeten gefunden.';
  return events.map((ev, i) => {
    const date = ev.created_at
      ? new Date(ev.created_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
      : 'Unbekannt';
    const type = ev.source || ev.type || '';
    const typeTag = type ? ` [${type}]` : '';
    return `${i + 1}. [${date}]${typeTag} ${ev.name || ev.content || ev.summary || ''}`;
  }).join('\n');
}

// --- Tool definitions ---
const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search the graphiti-mem temporal knowledge graph for facts, decisions, and observations. Uses semantic search across all stored knowledge for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query (e.g., "why did we choose Kuzu", "authentication decisions")',
        },
        time_range: {
          type: 'string',
          description: 'Optional time filter: "today", "last_week", "last_month", or ISO date range "2024-01-01/2024-03-01"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_entities',
    description: 'List entities (projects, technologies, people, concepts, decisions) stored in the knowledge graph for the current project.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Entity type filter: "project", "person", "technology", "concept", "decision", "file"',
        },
        name: {
          type: 'string',
          description: 'Exact or partial name match',
        },
        related_to: {
          type: 'string',
          description: 'Find entities related to this term',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
  },
  {
    name: 'get_relationships',
    description: 'Explore connections between entities in the knowledge graph. Shows how concepts, technologies, and decisions are related.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source entity name',
        },
        target: {
          type: 'string',
          description: 'Target entity name',
        },
        type: {
          type: 'string',
          description: 'Relationship type: "uses", "depends_on", "decided", "created", "modified", "related_to"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
  },
  {
    name: 'get_timeline',
    description: 'View chronological history of events, decisions, and changes for the current project or a specific entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Filter timeline to a specific entity name',
        },
        type: {
          type: 'string',
          description: 'Event type: "decision", "change", "observation", "milestone", "session_summary"',
        },
        range: {
          type: 'string',
          description: 'Time range: "today", "last_week", "last_month", or ISO range',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events (default: 15)',
        },
      },
    },
  },
];

// --- Server setup ---
const server = new Server(
  { name: 'graphiti-mem', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_memory': {
        const body = {
          project_id: PROJECT_ID,
          query: args.query,
          num_results: args.limit || 10,
        };
        if (args.time_range) body.time_range = args.time_range;

        const result = await httpRequest('POST', '/search', body);
        const facts = result.facts || result.results || [];

        const header = `Suchergebnisse fuer "${args.query}" in Projekt ${PROJECT_NAME}:\n`;
        return {
          content: [{ type: 'text', text: header + formatFacts(facts) }],
        };
      }

      case 'get_entities': {
        const body = {
          project_id: PROJECT_ID,
          limit: args.limit || 20,
        };
        if (args.type) body.type = args.type;
        if (args.name) body.name = args.name;
        if (args.related_to) body.related_to = args.related_to;

        const result = await httpRequest('POST', '/entities', body);
        const entities = result.entities || [];

        const header = `Entitaeten in Projekt ${PROJECT_NAME}${args.type ? ` (Typ: ${args.type})` : ''}:\n\n`;
        return {
          content: [{ type: 'text', text: header + formatEntities(entities) }],
        };
      }

      case 'get_relationships': {
        const body = {
          project_id: PROJECT_ID,
          limit: args.limit || 20,
        };
        if (args.source) body.source = args.source;
        if (args.target) body.target = args.target;
        if (args.type) body.type = args.type;

        const result = await httpRequest('POST', '/relationships', body);
        const rels = result.relationships || [];

        const header = `Beziehungen in Projekt ${PROJECT_NAME}:\n\n`;
        return {
          content: [{ type: 'text', text: header + formatRelationships(rels) }],
        };
      }

      case 'get_timeline': {
        const body = {
          project_id: PROJECT_ID,
          limit: args.limit || 15,
        };
        if (args.entity) body.entity = args.entity;
        if (args.type) body.type = args.type;
        if (args.range) body.time_range = args.range;

        const result = await httpRequest('POST', '/timeline', body);
        const events = result.events || result.timeline || [];

        const header = `Timeline fuer Projekt ${PROJECT_NAME}${args.entity ? ` (Entity: ${args.entity})` : ''}:\n\n`;
        return {
          content: [{ type: 'text', text: header + formatTimeline(events) }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unbekanntes Tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const isConnErr = err.code === 'ECONNREFUSED';
    const msg = isConnErr
      ? `graphiti-mem Worker ist nicht erreichbar auf Port ${WORKER_PORT}. Starte den Worker mit: node worker-runner.js start`
      : `Fehler bei ${name}: ${err.message}`;
    return {
      content: [{ type: 'text', text: msg }],
      isError: true,
    };
  }
});

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[graphiti-mem MCP] Fatal: ${err.message}`);
  process.exit(1);
});
