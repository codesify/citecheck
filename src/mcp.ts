#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { scanDomain } from './scanner.js';

const domainInputSchema = z.object({
  domain: z.string().min(1).describe('Target domain or URL (e.g. example.com or https://example.com)'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30_000)
    .optional()
    .describe('Per-request timeout in milliseconds (default 10000)'),
});

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'citecheck', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'audit_domain',
    {
      title: 'Audit Domain for LLM Citation Readiness',
      description:
        'Inspect a domain for llms.txt presence, nested JSON-LD entity graphs, AI crawler permissions in robots.txt, and page-load latency, returning a 0-100 score and auto-generated fixes.',
      inputSchema: domainInputSchema,
    },
    async ({ domain, timeoutMs }) => {
      const report = await scanDomain(domain, { timeoutMs });
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  server.registerTool(
    'generate_llms_txt',
    {
      title: 'Generate llms.txt',
      description:
        'Scan a domain homepage metadata and navigation structure and return a spec-compliant llms.txt file.',
      inputSchema: domainInputSchema,
    },
    async ({ domain, timeoutMs }) => {
      const report = await scanDomain(domain, { timeoutMs });
      return {
        content: [{ type: 'text', text: report.fixes.llmsTxt }],
      };
    },
  );

  server.registerTool(
    'generate_schema_fix',
    {
      title: 'Generate JSON-LD and robots.txt Fixes',
      description:
        'Scan a domain and return a linked Schema.org JSON-LD @graph snippet and optional robots.txt patch for AI search bots.',
      inputSchema: domainInputSchema,
    },
    async ({ domain, timeoutMs }) => {
      const report = await scanDomain(domain, { timeoutMs });
      const payload = {
        domain: report.domain,
        existingIssues: report.jsonLd.issues,
        jsonLdObject: report.fixes.jsonLdObject,
        jsonLdSnippet: report.fixes.jsonLdSnippet,
        robotsTxtPatch: report.fixes.robotsTxtPatch,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  return server;
}

// CDS: serveStdio owns stdout for JSON-RPC framing; route transport errors exclusively to stderr.
serveStdio(createServer, {
  onerror: (err) => {
    process.stderr.write(`citecheck-mcp: ${err.message}\n`);
  },
});
