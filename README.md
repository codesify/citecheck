# citecheck(1)

Inspect any domain for LLM citation readiness (llms.txt, nested JSON-LD entity graphs, AI crawler rules in robots.txt, and page-load latency) and generate exact llms.txt, Schema.org JSON-LD, and robots.txt fixes.

## INSTALL

```sh
npm install -g citecheck
```

Requires Node.js >= 22.0.0.

## SYNOPSIS

```sh
npx citecheck stripe.com
citecheck [options] <domain>
citecheck-mcp
```

## OPTIONS

```text
-j, --json           Output full audit report as JSON to stdout
-w, --write <dir>    Write llms.txt, schema.jsonld, and robots.patch.txt to <dir>
    --llms-only      Print generated llms.txt to stdout
    --schema-only    Print generated JSON-LD <script> snippet to stdout
-t, --timeout <ms>   Per-request timeout in milliseconds (default: 10000)
-d, --debug          Write HTTP timing and status logs to stderr
-v, --version        Print version and exit
-h, --help           Show usage and exit
```

## MCP CONFIGURATION

Add to your MCP client configuration (Claude Desktop, Cursor, or any stdio MCP host):

```json
{
  "mcpServers": {
    "citecheck": {
      "command": "npx",
      "args": ["-y", "citecheck-mcp"]
    }
  }
}
```

Exposed MCP tools:

- `audit_domain` -- full 0-100 citation readiness report with generated fixes
- `generate_llms_txt` -- spec-compliant `llms.txt` built from discovered site metadata and navigation
- `generate_schema_fix` -- linked Schema.org `@graph` JSON-LD snippet and optional `robots.txt` patch

## EXAMPLE OUTPUT

```text
$ citecheck stripe.com
citecheck 0.1.0 -- stripe.com
SCORE: 85/100 (llms.txt 25/25 | json-ld 30/30 | robots 25/25 | latency 5/20)

[FAIL] LATENCY   status=200 ttfb=1254ms total=1583ms bytes=723823 grade=slow
[PASS] LLMS.TXT  status=200 sections=31 links=307 bytes=69815 llms-full=no
[PASS] JSON-LD   scripts=1 nodes=54 maxDepth=2 roots=[WebSite, Organization] entityLinks=yes sameAs=yes
[PASS] ROBOTS    status=200 sitemaps=1 blockedSearch=0 blockedTraining=0
       OAI-SearchBot      search     ALLOWED     (*: no root block)
       ChatGPT-User       user-fetch ALLOWED     (*: no root block)
       GPTBot             training   ALLOWED     (*: no root block)
       Claude-SearchBot   search     ALLOWED     (*: no root block)
       Claude-User        user-fetch ALLOWED     (*: no root block)
       ClaudeBot          training   ALLOWED     (*: no root block)
       PerplexityBot      search     ALLOWED     (*: no root block)
       Perplexity-User    user-fetch ALLOWED     (*: no root block)
       Google-Extended    training   ALLOWED     (*: no root block)
       Applebot-Extended  training   ALLOWED     (*: no root block)
       Meta-ExternalAgent training   ALLOWED     (*: no root block)
       CCBot              training   ALLOWED     (*: no root block)

GENERATED FIXES:
  Run with --llms-only, --schema-only, or --write <dir> to emit exact files.
```

```text
$ citecheck --write ./out example.com
wrote out/llms.txt
wrote out/schema.jsonld
wrote out/robots.patch.txt
```

## EXIT STATUS

- `0` -- scan completed
- `1` -- invalid arguments or fatal error

## SEE ALSO

Built by Codesify (https://codesify.com).

## LICENSE

MIT
