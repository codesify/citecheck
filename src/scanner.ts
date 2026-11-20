import { generateFixes } from './generators.js';
import type {
  AiBotRule,
  AuditReport,
  BotPurpose,
  BotStatus,
  JsonLdAudit,
  JsonLdNode,
  LatencyAudit,
  LlmsTxtAudit,
  NavLink,
  PageMetadata,
  RobotsAudit,
  ScanOptions,
  ScoreBreakdown,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = 'citecheck/0.1 (+https://github.com/citecheck)';

const AI_BOTS: ReadonlyArray<{ bot: string; vendor: string; purpose: BotPurpose }> = [
  { bot: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search' },
  { bot: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user-fetch' },
  { bot: 'GPTBot', vendor: 'OpenAI', purpose: 'training' },
  { bot: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search' },
  { bot: 'Claude-User', vendor: 'Anthropic', purpose: 'user-fetch' },
  { bot: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training' },
  { bot: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search' },
  { bot: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user-fetch' },
  { bot: 'Google-Extended', vendor: 'Google', purpose: 'training' },
  { bot: 'Applebot-Extended', vendor: 'Apple', purpose: 'training' },
  { bot: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training' },
  { bot: 'CCBot', vendor: 'CommonCrawl', purpose: 'training' },
];

const RECOMMENDED_FIELDS: Record<string, string[]> = {
  Organization: ['name', 'url', 'logo', 'sameAs', 'description'],
  WebSite: ['name', 'url', 'publisher'],
  WebPage: ['name', 'url', 'isPartOf'],
  SoftwareApplication: ['name', 'applicationCategory', 'operatingSystem', 'offers'],
  Product: ['name', 'description', 'offers'],
  Article: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  FAQPage: ['mainEntity'],
};

interface FetchResult {
  ok: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  contentType: string;
  text: string;
  ttfbMs: number | null;
  totalMs: number | null;
  error: string | null;
}

interface RobotsGroup {
  agents: string[];
  rules: Array<{ directive: 'allow' | 'disallow'; path: string }>;
}

export function normalizeTarget(input: string): { origin: string; domain: string } {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  return {
    origin: parsed.origin,
    domain: parsed.hostname.toLowerCase(),
  };
}

async function fetchResource(
  url: string,
  method: 'GET' | 'HEAD',
  options: Required<ScanOptions>,
): Promise<FetchResult> {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        'user-agent': options.userAgent,
        accept: method === 'GET' ? 'text/html,text/plain,application/json,*/*;q=0.8' : '*/*',
      },
    });
    const ttfbMs = Math.round(performance.now() - start);
    const text = method === 'HEAD' ? '' : await res.text();
    const totalMs = Math.round(performance.now() - start);
    const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';

    if (options.debug) {
      process.stderr.write(
        `[citecheck] ${method} ${url} -> ${res.status} ttfb=${ttfbMs}ms total=${totalMs}ms bytes=${Buffer.byteLength(text)}\n`,
      );
    }

    return {
      ok: res.ok,
      statusCode: res.status,
      finalUrl: res.url,
      contentType,
      text,
      ttfbMs,
      totalMs,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.debug) {
      process.stderr.write(`[citecheck] ${method} ${url} -> ERROR ${message}\n`);
    }
    return {
      ok: false,
      statusCode: null,
      finalUrl: null,
      contentType: '',
      text: '',
      ttfbMs: null,
      totalMs: null,
      error: message,
    };
  }
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html: string): string {
  return decodeHtml(html.replace(/<[^>]+>/g, ' '));
}

function extractMetaContent(html: string, attrName: string, attrValue: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*${attrName}=["']${attrValue}["'][^>]*content=["']([^"']+)["'][^>]*>|<meta\\b[^>]*content=["']([^"']+)["'][^>]*${attrName}=["']${attrValue}["'][^>]*>`,
    'i',
  );
  const match = html.match(re);
  const raw = match?.[1] ?? match?.[2];
  return raw ? decodeHtml(raw) : null;
}

function extractPageMetadata(html: string, origin: string): PageMetadata {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? stripTags(titleMatch[1]) : null;

  const description =
    extractMetaContent(html, 'name', 'description') ??
    extractMetaContent(html, 'property', 'og:description');

  const ogImageRaw = extractMetaContent(html, 'property', 'og:image');
  const ogImage =
    ogImageRaw && URL.canParse(ogImageRaw, origin) ? new URL(ogImageRaw, origin).href : null;

  const canonicalMatch = html.match(
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>|<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i,
  );
  const canonicalRaw = canonicalMatch?.[1] ?? canonicalMatch?.[2];
  const canonicalUrl =
    canonicalRaw && URL.canParse(canonicalRaw, origin) ? new URL(canonicalRaw, origin).href : null;

  const headings: string[] = [];
  for (const match of html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)) {
    const text = stripTags(match[1] ?? '');
    if (text.length >= 2 && text.length <= 140 && !headings.includes(text)) {
      headings.push(text);
    }
    if (headings.length >= 12) break;
  }

  const navLinks: NavLink[] = [];
  const seenHrefs = new Set<string>();
  const originHost = new URL(origin).hostname;

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawHref = match[1]?.trim();
    const label = stripTags(match[2] ?? '');
    if (!rawHref || !label || label.length < 2 || label.length > 60) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(rawHref)) continue;
    if (!URL.canParse(rawHref, origin)) continue;

    const resolved = new URL(rawHref, origin);
    if (resolved.hostname !== originHost) continue;
    if (resolved.pathname === '/' || /\.(png|jpe?g|svg|webp|ico|pdf|zip|xml|json)$/i.test(resolved.pathname)) {
      continue;
    }

    const cleanHref = `${resolved.origin}${resolved.pathname.replace(/\/+$/, '')}`;
    if (seenHrefs.has(cleanHref)) continue;
    seenHrefs.add(cleanHref);
    navLinks.push({ text: label, href: cleanHref });
    if (navLinks.length >= 40) break;
  }

  return {
    title,
    description,
    canonicalUrl,
    ogImage,
    headings,
    navLinks,
  };
}

function parseRobotsGroups(robotsTxt: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let seenRuleInGroup = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const sep = line.indexOf(':');
    if (sep === -1) continue;

    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'sitemap' && value) {
      if (!sitemaps.includes(value)) sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent' && value) {
      // CDS: RFC 9309 groups consecutive User-agent lines; a new User-agent after rules starts a fresh group.
      if (!current || seenRuleInGroup) {
        current = { agents: [value.toLowerCase()], rules: [] };
        groups.push(current);
        seenRuleInGroup = false;
      } else {
        current.agents.push(value.toLowerCase());
      }
      continue;
    }

    if ((field === 'allow' || field === 'disallow') && current) {
      seenRuleInGroup = true;
      current.rules.push({ directive: field, path: value });
    }
  }

  return { groups, sitemaps };
}

function matchesRootPath(rulePath: string): boolean {
  if (rulePath === '') return false;
  return rulePath === '/' || rulePath === '/*' || rulePath === '/$';
}

function evaluateBotForRoot(bot: string, groups: RobotsGroup[]): { status: BotStatus; matchedRule: string | null } {
  const botLower = bot.toLowerCase();
  const specificRules = groups
    .filter((g) => g.agents.some((a) => a === botLower))
    .flatMap((g) => g.rules);
  const wildcardRules = groups
    .filter((g) => g.agents.includes('*'))
    .flatMap((g) => g.rules);

  const activeRules = specificRules.length > 0 ? specificRules : wildcardRules;
  if (activeRules.length === 0) {
    return { status: 'unspecified', matchedRule: null };
  }

  let best: { directive: 'allow' | 'disallow'; path: string } | null = null;
  for (const rule of activeRules) {
    if (!matchesRootPath(rule.path)) continue;
    // CDS: RFC 9309 longest-match precedence; Allow wins ties over Disallow.
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.directive === 'allow')
    ) {
      best = rule;
    }
  }

  if (!best) {
    return { status: 'allowed', matchedRule: specificRules.length > 0 ? `${bot}: no root block` : '*: no root block' };
  }

  const scope = specificRules.length > 0 ? bot : '*';
  const label = `${scope} -> ${best.directive === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}`;
  return {
    status: best.directive === 'disallow' ? 'disallowed' : 'allowed',
    matchedRule: label,
  };
}

function auditRobots(url: string, res: FetchResult): RobotsAudit {
  const isHtmlFallback =
    res.contentType.includes('text/html') || /^\s*<!doctype\s+html|^\s*<html\b/i.test(res.text);
  const present = res.ok && !isHtmlFallback && res.text.trim().length > 0;

  if (!present) {
    const bots: AiBotRule[] = AI_BOTS.map((entry) => ({
      ...entry,
      status: 'unspecified',
      matchedRule: null,
    }));
    return {
      url,
      present: false,
      statusCode: res.statusCode,
      error: res.error,
      sitemaps: [],
      bots,
      blockedSearchBots: [],
      blockedTrainingBots: [],
    };
  }

  const { groups, sitemaps } = parseRobotsGroups(res.text);
  const bots: AiBotRule[] = AI_BOTS.map((entry) => {
    const result = evaluateBotForRoot(entry.bot, groups);
    return {
      ...entry,
      status: result.status,
      matchedRule: result.matchedRule,
    };
  });

  const blockedSearchBots = bots
    .filter((b) => (b.purpose === 'search' || b.purpose === 'user-fetch') && b.status === 'disallowed')
    .map((b) => b.bot);
  const blockedTrainingBots = bots
    .filter((b) => b.purpose === 'training' && b.status === 'disallowed')
    .map((b) => b.bot);

  return {
    url,
    present: true,
    statusCode: res.statusCode,
    error: null,
    sitemaps,
    bots,
    blockedSearchBots,
    blockedTrainingBots,
  };
}

function auditLlmsTxt(url: string, res: FetchResult, fullRes: FetchResult): LlmsTxtAudit {
  const isHtmlFallback =
    res.contentType.includes('text/html') || /^\s*<!doctype\s+html|^\s*<html\b/i.test(res.text);
  const present = res.ok && !isHtmlFallback && res.text.trim().length > 0;

  const fullIsHtmlFallback = fullRes.contentType.includes('text/html');
  const fullPresent = fullRes.ok && !fullIsHtmlFallback;

  if (!present) {
    return {
      url,
      present: false,
      fullPresent,
      statusCode: res.statusCode,
      error: res.error,
      title: null,
      summary: null,
      sectionCount: 0,
      linkCount: 0,
      byteLength: 0,
      validSpec: false,
      issues: ['Missing /llms.txt (or server returned HTML fallback instead of text/plain or text/markdown)'],
    };
  }

  const lines = res.text.split(/\r?\n/);
  const h1Line = lines.find((l) => /^#\s+\S/.test(l));
  const title = h1Line ? h1Line.replace(/^#\s+/, '').trim() : null;
  const quoteLine = lines.find((l) => /^>\s+\S/.test(l));
  const summary = quoteLine ? quoteLine.replace(/^>\s+/, '').trim() : null;
  const sectionCount = lines.filter((l) => /^##\s+\S/.test(l)).length;
  const linkCount = (res.text.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) ?? []).length;
  const byteLength = Buffer.byteLength(res.text, 'utf8');

  const issues: string[] = [];
  if (!title) issues.push('Missing required H1 title (`# Project Name`)');
  if (!summary) issues.push('Missing blockquote summary (`> ...`)');
  if (sectionCount === 0) issues.push('No H2 sections (`## ...`) organizing links');
  if (linkCount === 0) issues.push('No absolute markdown links (`[Title](https://...)`) found');

  return {
    url,
    present: true,
    fullPresent,
    statusCode: res.statusCode,
    error: null,
    title,
    summary,
    sectionCount,
    linkCount,
    byteLength,
    validSpec: Boolean(title) && linkCount > 0,
    issues,
  };
}

function normalizeTypes(rawType: unknown): string[] {
  if (typeof rawType === 'string') return [rawType];
  if (Array.isArray(rawType)) return rawType.filter((t): t is string => typeof t === 'string');
  return [];
}

function collectJsonLdNodes(
  value: unknown,
  depth: number,
  nodes: JsonLdNode[],
  refState: { hasIdRef: boolean; sameAs: string[]; orgName: string | null },
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdNodes(item, depth, nodes, refState);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;

  if (Array.isArray(record['@graph'])) {
    for (const graphItem of record['@graph']) {
      collectJsonLdNodes(graphItem, depth, nodes, refState);
    }
  }

  const keys = Object.keys(record);
  const types = normalizeTypes(record['@type']);
  const id = typeof record['@id'] === 'string' ? record['@id'] : null;

  if (id && types.length === 0 && keys.length === 1) {
    refState.hasIdRef = true;
    return;
  }

  if (types.length > 0) {
    const missingRecommended: string[] = [];
    for (const typeName of types) {
      const required = RECOMMENDED_FIELDS[typeName];
      if (!required) continue;
      for (const field of required) {
        if (!(field in record) && !missingRecommended.includes(field)) {
          missingRecommended.push(field);
        }
      }
    }

    if (types.includes('Organization') || types.includes('Corporation') || types.includes('WebSite')) {
      if (!refState.orgName && typeof record.name === 'string' && record.name.trim()) {
        refState.orgName = record.name.trim();
      }
      if (typeof record.sameAs === 'string') {
        if (!refState.sameAs.includes(record.sameAs)) refState.sameAs.push(record.sameAs);
      } else if (Array.isArray(record.sameAs)) {
        for (const link of record.sameAs) {
          if (typeof link === 'string' && !refState.sameAs.includes(link)) {
            refState.sameAs.push(link);
          }
        }
      }
    }

    nodes.push({
      id,
      types,
      depth,
      properties: keys.filter((k) => !k.startsWith('@')),
      missingRecommended,
    });
  }

  const nextDepth = types.length > 0 ? depth + 1 : depth;
  for (const [key, child] of Object.entries(record)) {
    if (key === '@graph' || key === '@context') continue;
    if (child && typeof child === 'object') {
      collectJsonLdNodes(child, nextDepth, nodes, refState);
    }
  }
}

function auditJsonLd(html: string): JsonLdAudit {
  const scriptRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [...html.matchAll(scriptRe)];
  const parseErrors: string[] = [];
  const jsonLdNodes: JsonLdNode[] = [];
  const refState = { hasIdRef: false, sameAs: [] as string[], orgName: null as string | null };

  for (let i = 0; i < blocks.length; i++) {
    const raw = (blocks[i]?.[1] ?? '').trim();
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      collectJsonLdNodes(parsed, 0, jsonLdNodes, refState);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      parseErrors.push(`Block #${i + 1}: ${msg}`);
    }
  }

  const rootTypes = [...new Set(jsonLdNodes.filter((n) => n.depth === 0).flatMap((n) => n.types))];
  const maxDepth = jsonLdNodes.reduce((max, n) => Math.max(max, n.depth), 0);
  const allTypes = new Set(jsonLdNodes.flatMap((n) => n.types));
  const hasOrganization = allTypes.has('Organization') || allTypes.has('Corporation');
  const hasWebSite = allTypes.has('WebSite');
  const hasSameAs = refState.sameAs.length > 0;
  const hasEntityLinks = refState.hasIdRef || maxDepth >= 1;

  const issues: string[] = [];
  if (blocks.length === 0) issues.push('No <script type="application/ld+json"> blocks found');
  if (parseErrors.length > 0) issues.push(`${parseErrors.length} JSON-LD block(s) failed JSON parsing`);
  if (!hasOrganization) issues.push('Missing Organization entity');
  if (!hasWebSite) issues.push('Missing WebSite entity');
  if (!hasEntityLinks && jsonLdNodes.length > 0) {
    issues.push('Flat schema without @id entity links or nested graph relationships');
  }
  if (!hasSameAs) issues.push('No sameAs authority links (GitHub, X, Wikipedia, LinkedIn)');

  return {
    scriptCount: blocks.length,
    parseErrors,
    nodes: jsonLdNodes,
    rootTypes,
    maxDepth,
    hasOrganization,
    hasWebSite,
    hasSameAs,
    hasEntityLinks,
    extractedName: refState.orgName,
    extractedSameAs: refState.sameAs,
    issues,
  };
}

function auditLatency(url: string, res: FetchResult): LatencyAudit {
  const contentBytes = Buffer.byteLength(res.text, 'utf8');
  if (res.error || res.ttfbMs === null) {
    return {
      url,
      finalUrl: res.finalUrl,
      statusCode: res.statusCode,
      ttfbMs: null,
      totalMs: null,
      contentBytes,
      grade: 'error',
      error: res.error ?? 'Unknown fetch error',
    };
  }

  let grade: LatencyAudit['grade'] = 'slow';
  if (res.ttfbMs <= 300) grade = 'fast';
  else if (res.ttfbMs <= 800) grade = 'acceptable';

  return {
    url,
    finalUrl: res.finalUrl,
    statusCode: res.statusCode,
    ttfbMs: res.ttfbMs,
    totalMs: res.totalMs,
    contentBytes,
    grade,
    error: null,
  };
}

function computeScore(
  llmsTxt: LlmsTxtAudit,
  jsonLd: JsonLdAudit,
  robots: RobotsAudit,
  latency: LatencyAudit,
): ScoreBreakdown {
  let llmsScore = 0;
  if (llmsTxt.present) {
    llmsScore += 12;
    if (llmsTxt.validSpec) llmsScore += 8;
    if (llmsTxt.fullPresent || llmsTxt.sectionCount >= 2) llmsScore += 5;
  }

  let jsonLdScore = 0;
  if (jsonLd.nodes.length > 0 && jsonLd.parseErrors.length === 0) jsonLdScore += 8;
  if (jsonLd.hasOrganization) jsonLdScore += 5;
  if (jsonLd.hasWebSite) jsonLdScore += 4;
  if (jsonLd.hasEntityLinks) jsonLdScore += 7;
  if (jsonLd.hasSameAs) jsonLdScore += 6;

  let robotsScore = 0;
  if (robots.present) robotsScore += 5;
  const searchPenalty = robots.blockedSearchBots.length * 5;
  robotsScore += Math.max(0, 15 - searchPenalty);
  if (robots.sitemaps.length > 0) robotsScore += 5;

  let latencyScore = 0;
  if (latency.ttfbMs !== null) {
    if (latency.ttfbMs <= 250) latencyScore = 20;
    else if (latency.ttfbMs <= 600) latencyScore = 16;
    else if (latency.ttfbMs <= 1200) latencyScore = 10;
    else if (latency.ttfbMs <= 2500) latencyScore = 5;
  }

  return {
    total: llmsScore + jsonLdScore + robotsScore + latencyScore,
    llmsTxt: llmsScore,
    jsonLd: jsonLdScore,
    robots: robotsScore,
    latency: latencyScore,
  };
}

export async function scanDomain(input: string, rawOptions: ScanOptions = {}): Promise<AuditReport> {
  const { origin, domain } = normalizeTarget(input);
  const options: Required<ScanOptions> = {
    timeoutMs: rawOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: rawOptions.userAgent ?? DEFAULT_USER_AGENT,
    debug: rawOptions.debug ?? false,
  };

  const pageUrl = `${origin}/`;
  const llmsUrl = `${origin}/llms.txt`;
  const llmsFullUrl = `${origin}/llms-full.txt`;
  const robotsUrl = `${origin}/robots.txt`;

  const [pageRes, llmsRes, llmsFullRes, robotsRes] = await Promise.all([
    fetchResource(pageUrl, 'GET', options),
    fetchResource(llmsUrl, 'GET', options),
    fetchResource(llmsFullUrl, 'HEAD', options),
    fetchResource(robotsUrl, 'GET', options),
  ]);

  const latency = auditLatency(pageUrl, pageRes);
  const llmsTxt = auditLlmsTxt(llmsUrl, llmsRes, llmsFullRes);
  const robots = auditRobots(robotsUrl, robotsRes);
  const jsonLd = auditJsonLd(pageRes.text);
  const metadata = extractPageMetadata(pageRes.text, origin);
  const score = computeScore(llmsTxt, jsonLd, robots, latency);
  const fixes = generateFixes(origin, domain, metadata, jsonLd, robots);

  return {
    domain,
    origin,
    scannedAt: new Date().toISOString(),
    score,
    latency,
    llmsTxt,
    robots,
    jsonLd,
    metadata,
    fixes,
  };
}
