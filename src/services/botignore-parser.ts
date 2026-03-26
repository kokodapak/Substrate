/**
 * Botignore parser — parses gitignore-style .botignore and .botinclude files
 * into structured access rules.
 */

export interface ParsedRule {
  pattern: string;
  domain: 'file' | 'service' | 'env' | 'integration' | 'any';
  action: 'deny' | 'allow';
}

interface ParseError {
  code: 'PARSE_ERROR';
  detail: string;
}

type DomainPrefix = 'service' | 'env' | 'integration' | 'file';

const DOMAIN_PREFIXES: DomainPrefix[] = ['service', 'env', 'integration', 'file'];

/**
 * Parse raw content lines into rules. Skips blank lines and # comments.
 * Negation (!) is not supported — all lines produce the given action.
 */
function parseContent(content: string, action: 'deny' | 'allow'): ParsedRule[] {
  if (typeof content !== 'string') {
    const err: ParseError = { code: 'PARSE_ERROR', detail: 'content must be a string' };
    throw err;
  }

  const rules: ParsedRule[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Remove trailing carriage return
    const trimmed = (raw ?? '').replace(/\r$/, '').trim();

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Detect domain prefix
    let domain: ParsedRule['domain'] = 'any';
    let pattern = trimmed;

    for (const prefix of DOMAIN_PREFIXES) {
      if (trimmed.startsWith(`${prefix}:`)) {
        domain = prefix;
        pattern = trimmed.slice(prefix.length + 1);
        break;
      }
    }

    // After stripping prefix, pattern must not be empty
    if (pattern.trim() === '') {
      const err: ParseError = {
        code: 'PARSE_ERROR',
        detail: `Empty pattern on line ${i + 1}: ${JSON.stringify(raw)}`,
      };
      throw err;
    }

    rules.push({ pattern, domain, action });
  }

  return rules;
}

/**
 * Parse .botignore content — all rules are deny rules.
 */
export function parseBotignoreContent(content: string): ParsedRule[] {
  return parseContent(content, 'deny');
}

/**
 * Parse .botinclude content — all rules are allow rules.
 */
export function parseBotincludeContent(content: string): ParsedRule[] {
  return parseContent(content, 'allow');
}
