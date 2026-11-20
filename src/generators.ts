import type {
  GeneratedFixes,
  JsonLdAudit,
  NavLink,
  PageMetadata,
  RobotsAudit,
} from './types.js';

const DOC_PATH_RE = /\/(docs?|documentation|api|reference|guides?|sdk|cli|changelog|developers?)\b/i;
const COMPANY_PATH_RE = /\/(about|company|blog|news|press|careers|contact|security|trust|legal|privacy|terms)\b/i;
const PRODUCT_PATH_RE = /\/(product|features?|pricing|solutions?|platform|integrations?|customers?|case-studies|enterprise|use-cases)\b/i;

function resolveBrandName(domain: string, metadata: PageMetadata, jsonLd: JsonLdAudit): string {
  if (jsonLd.extractedName) return jsonLd.extractedName;
  if (metadata.title) {
    const split = metadata.title.split(/\s+[|\u2013\u2014:-]\s+/)[0]?.trim();
    if (split && split.length >= 2 && split.length <= 60) return split;
  }
  const hostLabel = domain.replace(/^www\./i, '').split('.')[0] ?? domain;
  return hostLabel.charAt(0).toUpperCase() + hostLabel.slice(1);
}

function classifyLinks(links: NavLink[]) {
  const docs: NavLink[] = [];
  const product: NavLink[] = [];
  const company: NavLink[] = [];
  const other: NavLink[] = [];

  for (const link of links) {
    if (DOC_PATH_RE.test(link.href)) {
      docs.push(link);
    } else if (PRODUCT_PATH_RE.test(link.href)) {
      product.push(link);
    } else if (COMPANY_PATH_RE.test(link.href)) {
      company.push(link);
    } else {
      other.push(link);
    }
  }

  return { docs, product, company, other };
}

function formatLinkSection(heading: string, links: NavLink[], limit: number): string[] {
  const slice = links.slice(0, limit);
  if (slice.length === 0) return [];
  const lines = [`## ${heading}`, ''];
  for (const item of slice) {
    lines.push(`- [${item.text}](${item.href})`);
  }
  lines.push('');
  return lines;
}

export function generateLlmsTxt(
  origin: string,
  domain: string,
  metadata: PageMetadata,
  jsonLd: JsonLdAudit,
): string {
  const brand = resolveBrandName(domain, metadata, jsonLd);
  const summary =
    metadata.description ??
    `Official web presence and documentation for ${brand} (${domain}).`;

  const lines: string[] = [`# ${brand}`, '', `> ${summary}`, ''];
  const grouped = classifyLinks(metadata.navLinks);

  const hasDiscovered =
    grouped.docs.length + grouped.product.length + grouped.company.length + grouped.other.length > 0;

  if (hasDiscovered) {
    lines.push(...formatLinkSection('Documentation', grouped.docs, 10));
    lines.push(...formatLinkSection('Product', grouped.product, 10));
    lines.push(...formatLinkSection('Company', grouped.company, 8));
    lines.push(...formatLinkSection('Optional', grouped.other, 8));
  } else {
    lines.push(
      '## Core Pages',
      '',
      `- [Home](${origin}/): Primary landing page for ${brand}`,
      `- [Documentation](${origin}/docs): Technical documentation and guides`,
      `- [Pricing](${origin}/pricing): Plans and product tiers`,
      '',
      '## Optional',
      '',
      `- [About](${origin}/about): Company overview and contact information`,
      '',
    );
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function generateJsonLdGraph(
  origin: string,
  domain: string,
  metadata: PageMetadata,
  jsonLd: JsonLdAudit,
): Record<string, unknown> {
  const brand = resolveBrandName(domain, metadata, jsonLd);
  const canonical = metadata.canonicalUrl ?? `${origin}/`;
  const description =
    metadata.description ?? `${brand} official website and product documentation.`;
  const sameAs =
    jsonLd.extractedSameAs.length > 0
      ? jsonLd.extractedSameAs
      : [
          `https://github.com/${domain.replace(/^www\./i, '').split('.')[0] ?? domain}`,
          `https://x.com/${domain.replace(/^www\./i, '').split('.')[0] ?? domain}`,
        ];

  const orgId = `${origin}/#organization`;
  const websiteId = `${origin}/#website`;
  const webpageId = `${origin}/#webpage`;

  const orgNode: Record<string, unknown> = {
    '@type': 'Organization',
    '@id': orgId,
    name: brand,
    url: origin,
    description,
    sameAs,
  };

  if (metadata.ogImage) {
    orgNode.logo = {
      '@type': 'ImageObject',
      url: metadata.ogImage,
    };
  }

  const websiteNode: Record<string, unknown> = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: origin,
    name: brand,
    description,
    publisher: { '@id': orgId },
  };

  const webpageNode: Record<string, unknown> = {
    '@type': 'WebPage',
    '@id': webpageId,
    url: canonical,
    name: metadata.title ?? brand,
    description,
    isPartOf: { '@id': websiteId },
    about: { '@id': orgId },
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [orgNode, websiteNode, webpageNode],
  };
}

export function generateRobotsPatch(robots: RobotsAudit): string | null {
  if (robots.blockedSearchBots.length === 0 && robots.present && robots.sitemaps.length > 0) {
    return null;
  }

  const lines: string[] = [];

  if (robots.blockedSearchBots.length > 0) {
    for (const bot of robots.blockedSearchBots) {
      lines.push(`User-agent: ${bot}`, 'Allow: /', '');
    }
  } else if (!robots.present) {
    lines.push(
      'User-agent: *',
      'Allow: /',
      '',
      'User-agent: OAI-SearchBot',
      'Allow: /',
      '',
      'User-agent: Claude-SearchBot',
      'Allow: /',
      '',
      'User-agent: PerplexityBot',
      'Allow: /',
      '',
    );
  }

  if (robots.sitemaps.length === 0) {
    const origin = new URL(robots.url).origin;
    lines.push(`Sitemap: ${origin}/sitemap.xml`);
  }

  return lines.length > 0 ? lines.join('\n').trimEnd() + '\n' : null;
}

export function generateFixes(
  origin: string,
  domain: string,
  metadata: PageMetadata,
  jsonLd: JsonLdAudit,
  robots: RobotsAudit,
): GeneratedFixes {
  const llmsTxt = generateLlmsTxt(origin, domain, metadata, jsonLd);
  const jsonLdObject = generateJsonLdGraph(origin, domain, metadata, jsonLd);
  const jsonLdSnippet = `<script type="application/ld+json">\n${JSON.stringify(jsonLdObject, null, 2)}\n</script>\n`;
  const robotsTxtPatch = generateRobotsPatch(robots);

  return {
    llmsTxt,
    jsonLdObject,
    jsonLdSnippet,
    robotsTxtPatch,
  };
}
