import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalAddress } from '../cli/commands/init.js';
import { applyCaddyRoutes, generateManualRouteSnippet, generateRouteBlocks } from '../cli/lib/caddy.js';

describe('isLocalAddress', () => {
  // Positive cases — should return true
  test('localhost', () => {
    expect(isLocalAddress('localhost')).toBe(true);
  });

  test('localhost with trailing dot (FQDN)', () => {
    expect(isLocalAddress('localhost.')).toBe(true);
  });

  test('localhost case-insensitive', () => {
    expect(isLocalAddress('LOCALHOST')).toBe(true);
    expect(isLocalAddress('Localhost')).toBe(true);
  });

  test('localhost with whitespace', () => {
    expect(isLocalAddress('  localhost  ')).toBe(true);
  });

  test('0.0.0.0 (bind-all)', () => {
    expect(isLocalAddress('0.0.0.0')).toBe(true);
  });

  test('127.x.x.x loopback', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('127.0.1.1')).toBe(true);
    expect(isLocalAddress('127.255.255.255')).toBe(true);
  });

  test('10.x.x.x private range', () => {
    expect(isLocalAddress('10.0.0.1')).toBe(true);
    expect(isLocalAddress('10.255.0.1')).toBe(true);
  });

  test('172.16-31.x.x private range', () => {
    expect(isLocalAddress('172.16.0.1')).toBe(true);
    expect(isLocalAddress('172.19.0.1')).toBe(true);
    expect(isLocalAddress('172.20.0.1')).toBe(true);
    expect(isLocalAddress('172.31.255.255')).toBe(true);
  });

  test('192.168.x.x private range', () => {
    expect(isLocalAddress('192.168.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.100')).toBe(true);
  });

  test('::1 IPv6 loopback', () => {
    expect(isLocalAddress('::1')).toBe(true);
  });

  test('::ffff:127.0.0.1 IPv4-mapped IPv6 loopback', () => {
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
  });

  test('fe80:: IPv6 link-local', () => {
    expect(isLocalAddress('fe80::1')).toBe(true);
    expect(isLocalAddress('FE80::abc')).toBe(true);
  });

  test('fc00::/fd00:: IPv6 unique local', () => {
    expect(isLocalAddress('fc00::1')).toBe(true);
    expect(isLocalAddress('fd00::1')).toBe(true);
    expect(isLocalAddress('fd12::1')).toBe(true);
  });

  // Negative cases — should return false
  test('public domain', () => {
    expect(isLocalAddress('example.com')).toBe(false);
    expect(isLocalAddress('yos.example.com')).toBe(false);
  });

  test('public IP', () => {
    expect(isLocalAddress('8.8.8.8')).toBe(false);
    expect(isLocalAddress('1.1.1.1')).toBe(false);
  });

  test('172.x outside private range (172.15, 172.32)', () => {
    expect(isLocalAddress('172.15.0.1')).toBe(false);
    expect(isLocalAddress('172.32.0.1')).toBe(false);
  });

  test('192.x outside private range', () => {
    expect(isLocalAddress('192.167.1.1')).toBe(false);
    expect(isLocalAddress('192.169.1.1')).toBe(false);
  });

  test('::2 is not loopback', () => {
    expect(isLocalAddress('::2')).toBe(false);
  });

  test('public IPv6', () => {
    expect(isLocalAddress('2001:db8::1')).toBe(false);
  });
});

describe('generateRouteBlocks', () => {
  test('adds X-Forwarded-Prefix for stripped reverse proxy routes', () => {
    const block = generateRouteBlocks([{
      path: '/recruit/*',
      type: 'reverse_proxy',
      target: 'localhost:3465',
      strip_prefix: '/recruit',
    }]);

    expect(block).toContain('    redir /recruit /recruit/ permanent');
    expect(block).toContain('        uri strip_prefix /recruit');
    expect(block).toContain('        reverse_proxy localhost:3465 {');
    expect(block).toContain('            header_up X-Forwarded-Prefix /recruit');
  });

  test('keeps simple reverse proxy routes as single-line directives', () => {
    const block = generateRouteBlocks([{
      path: '/api/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
    }]);

    expect(block).toContain('        reverse_proxy localhost:3000');
    expect(block).not.toContain('header_up X-Forwarded-Prefix');
    expect(block).not.toContain('reverse_proxy localhost:3000 {');
  });
});

describe('generateManualRouteSnippet', () => {
  test('wraps route blocks in yos component markers', () => {
    const snippet = generateManualRouteSnippet('dashboard', [{
      path: '/dashboard/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
      strip_prefix: '/dashboard',
    }]);

    expect(snippet).toContain('    # BEGIN yos-component:dashboard');
    expect(snippet).toContain('    redir /dashboard /dashboard/ permanent');
    expect(snippet).toContain('        uri strip_prefix /dashboard');
    expect(snippet).toContain('        reverse_proxy localhost:3000 {');
    expect(snippet).toContain('            header_up X-Forwarded-Prefix /dashboard');
    expect(snippet).toContain('    # END yos-component:dashboard');
  });
});

describe('applyCaddyRoutes', () => {
  test('returns manual configuration details when yos-managed Caddy is unavailable', () => {
    const result = applyCaddyRoutes('dashboard', [{
      path: '/dashboard/*',
      type: 'reverse_proxy',
      target: 'localhost:3000',
      strip_prefix: '/dashboard',
    }], {
      isCaddyAvailable: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe('manual_required');
    expect(result.error).toBe('caddy_not_available');
    expect(result.caddyfile).toBeTruthy();
    expect(result.caddyBin).toBeTruthy();
    expect(result.manualConfigPlacement).toBe('inside_primary_site_block');
    expect(result.message).toBe('YOS-managed Caddy is not available. HTTP routes were not configured automatically.');
    expect(result.manualConfig).toContain('# BEGIN yos-component:dashboard');
    expect(result.manualConfig).toContain('handle /dashboard/* {');
    expect(result.manualConfig).toContain('reverse_proxy localhost:3000 {');
  });

  test('skips empty route declarations before checking Caddy availability', () => {
    const result = applyCaddyRoutes('dashboard', [], {
      isCaddyAvailable: () => false,
    });

    expect(result).toEqual({ success: true, action: 'skipped' });
  });
});

// TD-171 / upstream #744: every Caddyfile we generate must carry X-Robots-Tag.
// The agent's own HTTP surface (file share, web console, health) is never
// meant to be indexed — and there are three independent generation sources,
// so a fix applied to only one of them silently leaves the other two open.
// These tests exist so that removing the directive from ANY source fails red.
describe('X-Robots-Tag parity across all Caddyfile generation sources', () => {
  const NOINDEX_DIRECTIVE = '    header >X-Robots-Tag "noindex, nofollow"';
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

  // Pull out every backtick template literal so we can assert on the one that
  // actually renders a Caddyfile, rather than grepping the whole file.
  function extractTemplateLiterals(source) {
    const literals = [];
    let i = 0;
    while (i < source.length) {
      if (source[i] === '`') {
        const start = i + 1;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') break;
          i++;
        }
        literals.push(source.slice(start, i));
        i++;
      } else {
        i++;
      }
    }
    return literals;
  }

  function caddyLiteralOf(relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const hits = extractTemplateLiterals(src).filter(l => l.includes('YOS Caddyfile'));
    expect(hits.length).toBeGreaterThan(0);
    return hits[0];
  }

  test('cli/commands/init.js embeds X-Robots-Tag in its Caddyfile template literal', () => {
    expect(caddyLiteralOf('cli/commands/init.js')).toContain(NOINDEX_DIRECTIVE);
  });

  test('skills/http/scripts/setup-caddy.js embeds X-Robots-Tag in its Caddyfile template literal', () => {
    expect(caddyLiteralOf(path.join('skills', 'http', 'scripts', 'setup-caddy.js')))
      .toContain(NOINDEX_DIRECTIVE);
  });

  test('skills/http/Caddyfile.template contains X-Robots-Tag as a directive, not a comment', () => {
    const template = fs.readFileSync(
      path.join(ROOT, 'skills', 'http', 'Caddyfile.template'), 'utf8'
    );
    const directives = template.split('\n').filter(l => !l.trim().startsWith('#'));
    expect(directives.some(l => l.includes('header >X-Robots-Tag "noindex, nofollow"'))).toBe(true);
  });
});
