#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scanDomain } from './scanner.js';
import type { AuditReport } from './types.js';

const VERSION = '0.1.0';

const USAGE = `Usage: citecheck [options] <domain>

Inspect a domain for LLM citation readiness and generate llms.txt and JSON-LD fixes.

Options:
  -j, --json           Output full audit report as JSON
  -w, --write <dir>    Write generated llms.txt, schema.jsonld, and robots.patch.txt to <dir>
      --llms-only      Print only the generated llms.txt to stdout
      --schema-only    Print only the generated JSON-LD <script> snippet to stdout
  -t, --timeout <ms>   Per-request timeout in milliseconds (default: 10000)
  -d, --debug          Log HTTP timing and errors to stderr
  -v, --version        Print version and exit
  -h, --help           Show this help message and exit
`;

function statusTag(ok: boolean, warn = false): string {
  if (ok) return '[PASS]';
  return warn ? '[WARN]' : '[FAIL]';
}

function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`citecheck ${VERSION} -- ${report.domain}`);
  lines.push(
    `SCORE: ${report.score.total}/100 (llms.txt ${report.score.llmsTxt}/25 | json-ld ${report.score.jsonLd}/30 | robots ${report.score.robots}/25 | latency ${report.score.latency}/20)`,
  );
  lines.push('');

  const latTag = statusTag(report.latency.grade === 'fast', report.latency.grade === 'acceptable');
  const latDetail = report.latency.error
    ? `error=${report.latency.error}`
    : `status=${report.latency.statusCode} ttfb=${report.latency.ttfbMs}ms total=${report.latency.totalMs}ms bytes=${report.latency.contentBytes} grade=${report.latency.grade}`;
  lines.push(`${latTag} LATENCY   ${latDetail}`);

  const llmsTag = statusTag(report.llmsTxt.present && report.llmsTxt.validSpec, report.llmsTxt.present);
  const llmsDetail = report.llmsTxt.present
    ? `status=${report.llmsTxt.statusCode} sections=${report.llmsTxt.sectionCount} links=${report.llmsTxt.linkCount} bytes=${report.llmsTxt.byteLength} llms-full=${report.llmsTxt.fullPresent ? 'yes' : 'no'}`
    : `status=${report.llmsTxt.statusCode ?? 'err'} missing`;
  lines.push(`${llmsTag} LLMS.TXT  ${llmsDetail}`);
  for (const issue of report.llmsTxt.issues) {
    lines.push(`       - ${issue}`);
  }

  const ldOk =
    report.jsonLd.nodes.length > 0 &&
    report.jsonLd.parseErrors.length === 0 &&
    report.jsonLd.hasOrganization &&
    report.jsonLd.hasWebSite &&
    report.jsonLd.hasEntityLinks;
  const ldTag = statusTag(ldOk, report.jsonLd.nodes.length > 0);
  const rootLabel = report.jsonLd.rootTypes.length > 0 ? report.jsonLd.rootTypes.join(', ') : 'none';
  lines.push(
    `${ldTag} JSON-LD   scripts=${report.jsonLd.scriptCount} nodes=${report.jsonLd.nodes.length} maxDepth=${report.jsonLd.maxDepth} roots=[${rootLabel}] entityLinks=${report.jsonLd.hasEntityLinks ? 'yes' : 'no'} sameAs=${report.jsonLd.hasSameAs ? 'yes' : 'no'}`,
  );
  for (const issue of report.jsonLd.issues) {
    lines.push(`       - ${issue}`);
  }

  const robotsOk = report.robots.present && report.robots.blockedSearchBots.length === 0;
  const robotsTag = statusTag(robotsOk, report.robots.blockedSearchBots.length === 0);
  lines.push(
    `${robotsTag} ROBOTS    status=${report.robots.statusCode ?? 'err'} sitemaps=${report.robots.sitemaps.length} blockedSearch=${report.robots.blockedSearchBots.length} blockedTraining=${report.robots.blockedTrainingBots.length}`,
  );
  for (const bot of report.robots.bots) {
    const padBot = bot.bot.padEnd(18);
    const padPurpose = bot.purpose.padEnd(10);
    const padStatus = bot.status.toUpperCase().padEnd(11);
    const rule = bot.matchedRule ? ` (${bot.matchedRule})` : '';
    lines.push(`       ${padBot} ${padPurpose} ${padStatus}${rule}`);
  }

  lines.push('');
  lines.push('GENERATED FIXES:');
  lines.push('  Run with --llms-only, --schema-only, or --write <dir> to emit exact files.');
  if (report.fixes.robotsTxtPatch) {
    lines.push('  robots.txt patch recommended (search crawlers blocked or sitemap missing).');
  }

  return lines.join('\n') + '\n';
}

async function writeGeneratedFiles(dir: string, report: AuditReport): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];

  const llmsPath = join(dir, 'llms.txt');
  await writeFile(llmsPath, report.fixes.llmsTxt, 'utf8');
  written.push(llmsPath);

  const schemaPath = join(dir, 'schema.jsonld');
  await writeFile(schemaPath, JSON.stringify(report.fixes.jsonLdObject, null, 2) + '\n', 'utf8');
  written.push(schemaPath);

  if (report.fixes.robotsTxtPatch) {
    const robotsPath = join(dir, 'robots.patch.txt');
    await writeFile(robotsPath, report.fixes.robotsTxtPatch, 'utf8');
    written.push(robotsPath);
  }

  return written;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean', short: 'j', default: false },
      write: { type: 'string', short: 'w' },
      'llms-only': { type: 'boolean', default: false },
      'schema-only': { type: 'boolean', default: false },
      timeout: { type: 'string', short: 't' },
      debug: { type: 'boolean', short: 'd', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const target = positionals[0];
  if (!target) {
    process.stderr.write(`Error: missing <domain> argument.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const timeoutMs = values.timeout ? Number.parseInt(values.timeout, 10) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    process.stderr.write(`Error: --timeout must be a positive integer.\n`);
    process.exitCode = 1;
    return;
  }

  const report = await scanDomain(target, {
    timeoutMs,
    debug: values.debug,
  });

  if (values.write) {
    const written = await writeGeneratedFiles(values.write, report);
    for (const filePath of written) {
      process.stderr.write(`wrote ${filePath}\n`);
    }
  }

  if (values['llms-only']) {
    process.stdout.write(report.fixes.llmsTxt);
    return;
  }

  if (values['schema-only']) {
    process.stdout.write(report.fixes.jsonLdSnippet);
    return;
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  process.stdout.write(formatReport(report));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`citecheck: ${message}\n`);
  process.exitCode = 1;
});
