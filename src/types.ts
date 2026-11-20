export type BotStatus = 'allowed' | 'disallowed' | 'unspecified';

export type BotPurpose = 'search' | 'training' | 'user-fetch';

export interface AiBotRule {
  bot: string;
  vendor: string;
  purpose: BotPurpose;
  status: BotStatus;
  matchedRule: string | null;
}

export interface RobotsAudit {
  url: string;
  present: boolean;
  statusCode: number | null;
  error: string | null;
  sitemaps: string[];
  bots: AiBotRule[];
  blockedSearchBots: string[];
  blockedTrainingBots: string[];
}

export interface LlmsTxtAudit {
  url: string;
  present: boolean;
  fullPresent: boolean;
  statusCode: number | null;
  error: string | null;
  title: string | null;
  summary: string | null;
  sectionCount: number;
  linkCount: number;
  byteLength: number;
  validSpec: boolean;
  issues: string[];
}

export interface JsonLdNode {
  id: string | null;
  types: string[];
  depth: number;
  properties: string[];
  missingRecommended: string[];
}

export interface JsonLdAudit {
  scriptCount: number;
  parseErrors: string[];
  nodes: JsonLdNode[];
  rootTypes: string[];
  maxDepth: number;
  hasOrganization: boolean;
  hasWebSite: boolean;
  hasSameAs: boolean;
  hasEntityLinks: boolean;
  extractedName: string | null;
  extractedSameAs: string[];
  issues: string[];
}

export interface LatencyAudit {
  url: string;
  finalUrl: string | null;
  statusCode: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  contentBytes: number;
  grade: 'fast' | 'acceptable' | 'slow' | 'error';
  error: string | null;
}

export interface NavLink {
  text: string;
  href: string;
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  ogImage: string | null;
  headings: string[];
  navLinks: NavLink[];
}

export interface ScoreBreakdown {
  total: number;
  llmsTxt: number;
  jsonLd: number;
  robots: number;
  latency: number;
}

export interface GeneratedFixes {
  llmsTxt: string;
  jsonLdObject: Record<string, unknown>;
  jsonLdSnippet: string;
  robotsTxtPatch: string | null;
}

export interface AuditReport {
  domain: string;
  origin: string;
  scannedAt: string;
  score: ScoreBreakdown;
  latency: LatencyAudit;
  llmsTxt: LlmsTxtAudit;
  robots: RobotsAudit;
  jsonLd: JsonLdAudit;
  metadata: PageMetadata;
  fixes: GeneratedFixes;
}

export interface ScanOptions {
  timeoutMs?: number;
  userAgent?: string;
  debug?: boolean;
}
