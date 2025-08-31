/**
 * Domain Matching Utilities - Node.js Implementation
 *
 * This module provides SECURITY CRITICAL domain matching functionality
 * that restricts Actions to specific domains for security purposes.
 */

import { URL } from 'url';
// @ts-ignore
import minimatch from 'minimatch';
import { getLogger } from '../services/logging';

let logger: ReturnType<typeof getLogger>;

/**
 * Initialize logger if not already done
 */
function initLogger() {
  if (!logger) {
    logger = getLogger();
  }
}

/**
 * Check if a URL is a new tab page (about:blank, chrome://new-tab-page)
 * @param url - URL to check
 * @returns boolean - True if it's a new tab page
 */
export function isNewTabPage(url: string): boolean {
  return (
    url === 'about:blank' ||
    url === 'chrome://new-tab-page/' ||
    url === 'chrome://new-tab-page'
  );
}

/**
 * Check if a URL matches a domain pattern. SECURITY CRITICAL.
 *
 * Supports optional glob patterns and schemes:
 * - *.example.com will match sub.example.com and example.com
 * - *google.com will match google.com, agoogle.com, and www.google.com
 * - http*://example.com will match http://example.com, https://example.com
 * - chrome-extension://* will match chrome-extension://aaaaaaaaaaaa and chrome-extension://bbbbbbbbbbbbb
 *
 * When no scheme is specified, https is used by default for security.
 * For example, 'example.com' will match 'https://example.com' but not 'http://example.com'.
 *
 * Note: New tab pages (about:blank, chrome://new-tab-page) must be handled at the callsite, not inside this function.
 *
 * @param url - The URL to check
 * @param domainPattern - Domain pattern to match against
 * @param logWarnings - Whether to log warnings about unsafe patterns
 * @returns boolean - True if the URL matches the pattern, False otherwise
 */
export function matchUrlWithDomainPattern(
  url: string,
  domainPattern: string,
  logWarnings: boolean = false
): boolean {
  try {
    initLogger();

    // Note: new tab pages should be handled at the callsite, not here
    if (isNewTabPage(url)) {
      return false;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return false;
    }

    // Extract only the hostname and scheme components
    const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
    const domain = parsedUrl.hostname?.toLowerCase() || '';

    if (!scheme || !domain) {
      return false;
    }

    // Normalize the domain pattern
    domainPattern = domainPattern.toLowerCase();

    // Handle pattern with scheme
    let patternScheme: string;
    let patternDomain: string;

    if (domainPattern.includes('://')) {
      [patternScheme, patternDomain] = domainPattern.split('://', 2);
    } else {
      patternScheme = 'https'; // Default to matching only https for security
      patternDomain = domainPattern;
    }

    // Handle port in pattern (we strip ports from patterns since we already
    // extracted only the hostname from the URL)
    if (patternDomain.includes(':') && !patternDomain.startsWith(':')) {
      patternDomain = patternDomain.split(':', 2)[0];
    }

    // If scheme doesn't match, return False
    if (scheme !== patternScheme) {
      return false;
    }

    // Check for exact match
    if (patternDomain === '*' || domain === patternDomain) {
      return true;
    }

    // Handle glob patterns
    if (patternDomain.includes('*')) {
      if (logWarnings) {
        console.log(`DEBUG: Processing glob pattern: ${patternDomain}`);
      }

      // Check for unsafe glob patterns
      // First, check for patterns like *.*.domain which are unsafe
      if (
        (patternDomain.match(/\*\./g) || []).length > 1 ||
        (patternDomain.match(/\.\*/g) || []).length > 1
      ) {
        if (logWarnings) {
          logger.error(
            `⛔️ Multiple wildcards in pattern=[${domainPattern}] are not supported`
          );
        }
        return false; // Don't match unsafe patterns
      }

      // Check for wildcards in TLD part (example.*)
      if (patternDomain.endsWith('.*')) {
        if (logWarnings) {
          logger.error(
            `⛔️ Wildcard TLDs like in pattern=[${domainPattern}] are not supported for security`
          );
        }
        return false; // Don't match unsafe patterns
      }

      // Then check for embedded wildcards
      const bareDomain = patternDomain.replace(/\*\./g, '');
      if (bareDomain.includes('*')) {
        if (logWarnings) {
          logger.error(
            `⛔️ Only *.domain style patterns are supported, ignoring pattern=[${domainPattern}]`
          );
        }
        return false; // Don't match unsafe patterns
      }

      // Special handling for *.domain patterns
      if (patternDomain.startsWith('*.')) {
        if (logWarnings) {
          console.log(`DEBUG: Processing *.domain pattern`);
        }
        const parentDomain = patternDomain.substring(2);
        if (logWarnings) {
          console.log(`DEBUG: parentDomain=${parentDomain}, domain=${domain}`);
        }
        // *.google.com should NOT match google.com, only subdomains like docs.google.com
        // This ensures security by not allowing overly broad matches
      }

      // Normal case: match domain against pattern
      if (logWarnings) {
        console.log(
          `DEBUG: matching domain="${domain}" against pattern="${patternDomain}"`
        );
      }
      const matchResult = minimatch(domain, patternDomain);
      if (logWarnings) {
        console.log(`DEBUG: minimatch result: ${matchResult}`);
      }
      if (matchResult) {
        return true;
      }
    }

    return false;
  } catch (error) {
    initLogger();
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      `⛔️ Error matching URL ${url} with pattern ${domainPattern}: ${errorMessage}`
    );
    return false;
  }
}

/**
 * Check if multiple URLs match at least one of the domain patterns
 * @param urls - URLs to check
 * @param domainPatterns - Domain patterns to match against
 * @param logWarnings - Whether to log warnings about unsafe patterns
 * @returns boolean - True if at least one URL matches any pattern
 */
export function matchUrlsWithDomainPatterns(
  urls: string[],
  domainPatterns: string[],
  logWarnings: boolean = false
): boolean {
  if (!domainPatterns || domainPatterns.length === 0) {
    return true; // No restrictions
  }

  return urls.some((url) =>
    domainPatterns.some((pattern) =>
      matchUrlWithDomainPattern(url, pattern, logWarnings)
    )
  );
}

/**
 * Filter URLs that match the domain patterns
 * @param urls - URLs to filter
 * @param domainPatterns - Domain patterns to match against
 * @param logWarnings - Whether to log warnings about unsafe patterns
 * @returns string[] - URLs that match at least one pattern
 */
export function filterUrlsByDomainPatterns(
  urls: string[],
  domainPatterns: string[],
  logWarnings: boolean = false
): string[] {
  if (!domainPatterns || domainPatterns.length === 0) {
    return urls; // No restrictions
  }

  return urls.filter((url) =>
    domainPatterns.some((pattern) =>
      matchUrlWithDomainPattern(url, pattern, logWarnings)
    )
  );
}

/**
 * Validate domain patterns for security issues
 * @param domainPatterns - Domain patterns to validate
 * @returns ValidationResult - Result with any security warnings
 */
export interface DomainPatternValidationResult {
  isValid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateDomainPatterns(
  domainPatterns: string[]
): DomainPatternValidationResult {
  const result: DomainPatternValidationResult = {
    isValid: true,
    warnings: [],
    errors: [],
  };

  for (const pattern of domainPatterns) {
    // Check for overly permissive patterns
    if (pattern === '*' || pattern === '*.*') {
      result.errors.push(`Overly permissive pattern: ${pattern}`);
      result.isValid = false;
      continue;
    }

    // Check for overly broad TLD patterns
    if (
      pattern === '*.com' ||
      pattern === '*.org' ||
      pattern === '*.net' ||
      pattern === '*.io'
    ) {
      result.errors.push(`Overly broad pattern: ${pattern}`);
      result.isValid = false;
      continue;
    }

    // Check for multiple wildcards
    if ((pattern.match(/\*\./g) || []).length > 1) {
      result.errors.push(
        `Multiple wildcards in pattern '${pattern}' are not supported for security`
      );
      result.isValid = false;
    }

    // Check for wildcard TLDs
    if (pattern.endsWith('.*')) {
      result.errors.push(
        `Wildcard TLD in pattern '${pattern}' is not supported for security`
      );
      result.isValid = false;
    }

    // Check for embedded wildcards
    const bareDomain = pattern.replace(/\*\./g, '');
    if (bareDomain.includes('*')) {
      result.errors.push(
        `Only *.domain style patterns are supported, pattern '${pattern}' has embedded wildcards`
      );
      result.isValid = false;
    }

    // Check for non-HTTPS schemes
    if (pattern.startsWith('http://')) {
      result.errors.push(`Insecure protocol pattern: ${pattern}`);
      result.isValid = false;
    }
  }

  return result;
}

/**
 * Extract domain from URL for comparison
 * @param url - URL to extract domain from
 * @returns string | null - Domain or null if invalid
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname?.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Check if domain patterns are overly permissive
 * Useful for security warnings when using sensitive data
 * @param domainPatterns - Domain patterns to check
 * @returns boolean - True if patterns are overly permissive
 */
export function areDomainsOverlyPermissive(domainPatterns: string[]): boolean {
  if (!domainPatterns || domainPatterns.length === 0) {
    return true; // No restrictions at all
  }

  // Check for overly broad patterns
  const broadPatterns = ['*', '*.*', '*.com', '*.org', '*.net'];
  return domainPatterns.some((pattern) =>
    broadPatterns.includes(pattern.toLowerCase())
  );
}

/**
 * Suggest more specific domain patterns based on URLs
 * @param urls - URLs that were accessed
 * @param currentPatterns - Current domain patterns
 * @returns string[] - Suggested more specific patterns
 */
export function suggestSpecificDomainPatterns(
  urls: string[],
  currentPatterns: string[]
): string[] {
  const domains = urls.map(extractDomain).filter(Boolean) as string[];

  const uniqueDomains = [...new Set(domains)];

  // If current patterns are overly broad, suggest specific domains
  if (areDomainsOverlyPermissive(currentPatterns)) {
    return uniqueDomains.map((domain) => `https://${domain}`);
  }

  return [];
}
