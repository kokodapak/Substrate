/**
 * botignore-parser.test.ts — Unit tests for botignore/botinclude parser
 */

// Set env first — before any module that reads them is imported
process.env['DATABASE_URL'] = ':memory:';
process.env['SUBSTRATE_ADMIN_KEY'] = 'test-admin-key';
process.env['SUBSTRATE_AGENT_KEY'] = 'test-agent-key';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '0';

import { describe, it, expect } from 'vitest';
import { parseBotignoreContent, parseBotincludeContent } from '../services/botignore-parser';

describe('parseBotignoreContent', () => {
  it('returns empty array for empty content', () => {
    expect(parseBotignoreContent('')).toEqual([]);
  });

  it('ignores blank lines', () => {
    const content = '\n\n  \n\n';
    expect(parseBotignoreContent(content)).toEqual([]);
  });

  it('ignores comment lines starting with #', () => {
    const content = '# This is a comment\n# Another comment\n';
    expect(parseBotignoreContent(content)).toEqual([]);
  });

  it('ignores blank lines and comments mixed in', () => {
    const content = `
# Deny sensitive paths
/etc/secrets

# More comments

/var/log
`;
    const rules = parseBotignoreContent(content);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ pattern: '/etc/secrets', domain: 'any', action: 'deny' });
    expect(rules[1]).toEqual({ pattern: '/var/log', domain: 'any', action: 'deny' });
  });

  it('parses valid patterns with action=deny', () => {
    const content = '/etc/secrets\n*.key';
    const rules = parseBotignoreContent(content);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ pattern: '/etc/secrets', domain: 'any', action: 'deny' });
    expect(rules[1]).toEqual({ pattern: '*.key', domain: 'any', action: 'deny' });
  });

  it('strips service: prefix and sets domain=service', () => {
    const rules = parseBotignoreContent('service:redis-prod');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: 'redis-prod', domain: 'service', action: 'deny' });
  });

  it('strips env: prefix and sets domain=env', () => {
    const rules = parseBotignoreContent('env:DATABASE_URL');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: 'DATABASE_URL', domain: 'env', action: 'deny' });
  });

  it('strips file: prefix and sets domain=file', () => {
    const rules = parseBotignoreContent('file:/etc/passwd');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: '/etc/passwd', domain: 'file', action: 'deny' });
  });

  it('strips integration: prefix and sets domain=integration', () => {
    const rules = parseBotignoreContent('integration:stripe-prod');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: 'stripe-prod', domain: 'integration', action: 'deny' });
  });

  it('lines without domain prefix get domain=any', () => {
    const rules = parseBotignoreContent('/etc/secrets');
    expect(rules[0].domain).toBe('any');
  });

  it('parses a realistic .botignore example', () => {
    const content = `# Deny sensitive paths
/etc/secrets
service:redis-prod
env:DATABASE_URL
`;
    const rules = parseBotignoreContent(content);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toEqual({ pattern: '/etc/secrets', domain: 'any', action: 'deny' });
    expect(rules[1]).toEqual({ pattern: 'redis-prod', domain: 'service', action: 'deny' });
    expect(rules[2]).toEqual({ pattern: 'DATABASE_URL', domain: 'env', action: 'deny' });
  });

  it('throws PARSE_ERROR if content is not a string', () => {
    expect(() => parseBotignoreContent(123 as unknown as string)).toThrow();
    try {
      parseBotignoreContent(null as unknown as string);
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('PARSE_ERROR');
    }
  });

  it('throws PARSE_ERROR if pattern is empty after stripping prefix', () => {
    expect(() => parseBotignoreContent('service:')).toThrow();
    try {
      parseBotignoreContent('service:');
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe('PARSE_ERROR');
    }
  });
});

describe('parseBotincludeContent', () => {
  it('returns empty array for empty content', () => {
    expect(parseBotincludeContent('')).toEqual([]);
  });

  it('parses valid patterns with action=allow', () => {
    const content = '/etc/app/config\nservice:app-server';
    const rules = parseBotincludeContent(content);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ pattern: '/etc/app/config', domain: 'any', action: 'allow' });
    expect(rules[1]).toEqual({ pattern: 'app-server', domain: 'service', action: 'allow' });
  });

  it('ignores comments and blank lines', () => {
    const content = '# Allow paths\n\nservice:my-app\n';
    const rules = parseBotincludeContent(content);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ pattern: 'my-app', domain: 'service', action: 'allow' });
  });

  it('all rules have action=allow', () => {
    const rules = parseBotincludeContent('/foo\n/bar\nservice:baz');
    for (const rule of rules) {
      expect(rule.action).toBe('allow');
    }
  });
});
