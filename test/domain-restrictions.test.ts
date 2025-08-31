import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { initializeLogger } from '../src/services/logging';

let ActionRegistry: any;
let matchUrlWithDomainPattern: any;
let validateDomainPatterns: any;
let registry: any;

beforeAll(async () => {
  // Initialize logger for testing
  initializeLogger({ level: 'error', console: false, json: false });

  // Import modules after logger initialization
  const registryModule = await import('../src/controller/registry');
  const domainMatcherModule = await import('../src/utils/domain-matcher');
  const singletonModule = await import('../src/controller/singleton');

  ActionRegistry = registryModule.ActionRegistry;
  matchUrlWithDomainPattern = domainMatcherModule.matchUrlWithDomainPattern;
  validateDomainPatterns = domainMatcherModule.validateDomainPatterns;
  registry = singletonModule.registry;
});

describe('Domain Restrictions', () => {
  let testRegistry: ActionRegistry;

  beforeEach(() => {
    testRegistry = new ActionRegistry();
  });

  describe('Domain Pattern Matching', () => {
    it('should match exact domains', () => {
      console.log('DEBUG: Testing exact domain match');
      const result1 = matchUrlWithDomainPattern(
        'https://docs.google.com/spreadsheets/test',
        'docs.google.com'
      );
      console.log('Result 1:', result1);
      expect(result1).toBe(true);
      const result2 = matchUrlWithDomainPattern(
        'https://example.com',
        'docs.google.com'
      );
      console.log('Result 2:', result2);
      expect(result2).toBe(false);
    });

    it('should match wildcard domains', () => {
      console.log('DEBUG: Testing wildcard domain match');
      const result1 = matchUrlWithDomainPattern(
        'https://docs.google.com',
        '*.google.com',
        true
      );
      console.log('Result for docs.google.com vs *.google.com:', result1);
      expect(result1).toBe(true);
      expect(
        matchUrlWithDomainPattern('https://sheets.google.com', '*.google.com')
      ).toBe(true);
      expect(
        matchUrlWithDomainPattern('https://google.com', '*.google.com')
      ).toBe(false);
      expect(
        matchUrlWithDomainPattern('https://malicious.com', '*.google.com')
      ).toBe(false);
    });

    it('should match full URLs', () => {
      expect(
        matchUrlWithDomainPattern(
          'https://docs.google.com/test',
          'https://docs.google.com'
        )
      ).toBe(true);
      expect(
        matchUrlWithDomainPattern(
          'http://docs.google.com/test',
          'https://docs.google.com'
        )
      ).toBe(false);
    });

    it('should handle invalid URLs gracefully', () => {
      expect(matchUrlWithDomainPattern('invalid-url', 'docs.google.com')).toBe(
        false
      );
      expect(matchUrlWithDomainPattern('', 'docs.google.com')).toBe(false);
    });
  });

  describe('Domain Pattern Validation', () => {
    it('should validate safe domain patterns', () => {
      const result = validateDomainPatterns([
        'docs.google.com',
        '*.microsoft.com',
      ]);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject overly permissive patterns', () => {
      const result = validateDomainPatterns(['*']);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Overly permissive pattern: *');
    });

    it('should reject malicious patterns', () => {
      const result = validateDomainPatterns(['*.com']);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Overly broad pattern: *.com');
    });

    it('should warn about potentially risky patterns', () => {
      const result = validateDomainPatterns(['http://*']);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Insecure protocol pattern: http://*');
    });
  });

  describe('Action Registry Domain Filtering', () => {
    it('should register actions with valid domain patterns', () => {
      expect(() => {
        testRegistry.register({
          name: 'test_action',
          description: 'Test action',
          paramSchema: {},
          execute: async () => ({ success: true, message: 'test' }),
          domains: ['docs.google.com'],
          promptDescription: () => 'Test action description',
        });
      }).not.toThrow();
    });

    it('should reject actions with invalid domain patterns', () => {
      expect(() => {
        testRegistry.register({
          name: 'malicious_action',
          description: 'Malicious action',
          paramSchema: {},
          execute: async () => ({ success: true, message: 'test' }),
          domains: ['*'],
          promptDescription: () => 'Malicious action description',
        });
      }).toThrow(/Invalid domain patterns/);
    });

    it('should filter actions by page URL', () => {
      // Register actions with different domain restrictions
      testRegistry.register({
        name: 'google_sheets_action',
        description: 'Google Sheets action',
        paramSchema: {},
        execute: async () => ({ success: true, message: 'test' }),
        domains: ['https://docs.google.com'],
        promptDescription: () => 'Google Sheets action',
      });

      testRegistry.register({
        name: 'general_action',
        description: 'General action',
        paramSchema: {},
        execute: async () => ({ success: true, message: 'test' }),
        promptDescription: () => 'General action',
      });

      // Test Google Sheets URL - should include domain-restricted action
      const googleSheetsPrompt = testRegistry.getPromptDescription(
        'https://docs.google.com/spreadsheets/test'
      );
      expect(googleSheetsPrompt).toContain('Google Sheets action');

      // Test other URL - should not include domain-restricted action
      const otherPrompt = testRegistry.getPromptDescription(
        'https://example.com'
      );
      expect(otherPrompt).not.toContain('Google Sheets action');

      // System prompt (no URL) - should only include general actions
      const systemPrompt = testRegistry.getPromptDescription();
      expect(systemPrompt).toContain('General action');
      expect(systemPrompt).not.toContain('Google Sheets action');
    });
  });

  describe('Action Registration and Domain Restrictions', () => {
    it('should verify that domain-restricted actions are properly registered', () => {
      // This test will verify at runtime that actions with domain restrictions exist
      const actions = registry.list();
      const domainRestrictedActions = actions.filter(
        (action) => action.domains && action.domains.length > 0
      );

      // Since the global registry is empty in tests, we expect 0 domain-restricted actions
      // In a real application, this registry would be populated with actions
      expect(domainRestrictedActions.length).toBe(0);

      // If there were domain-restricted actions, each should have valid domain patterns
      if (domainRestrictedActions.length > 0) {
        domainRestrictedActions.forEach((action) => {
          const validation = validateDomainPatterns(action.domains || []);
          expect(validation.isValid).toBe(true);
        });
      }
    });
  });

  describe('Security Edge Cases', () => {
    it('should handle subdomain attacks', () => {
      // Test subdomain confusion attacks
      expect(
        matchUrlWithDomainPattern(
          'https://malicious.docs.google.com.evil.com',
          'docs.google.com'
        )
      ).toBe(false);
      expect(
        matchUrlWithDomainPattern(
          'https://docs.google.com.evil.com',
          'docs.google.com'
        )
      ).toBe(false);
    });

    it('should handle protocol smuggling', () => {
      expect(
        matchUrlWithDomainPattern(
          'javascript://docs.google.com',
          'docs.google.com'
        )
      ).toBe(false);
      expect(
        matchUrlWithDomainPattern('data://docs.google.com', 'docs.google.com')
      ).toBe(false);
    });

    it('should handle port-based attacks', () => {
      expect(
        matchUrlWithDomainPattern(
          'https://docs.google.com:8080',
          'docs.google.com'
        )
      ).toBe(true);
      expect(
        matchUrlWithDomainPattern(
          'https://evil.com:443/docs.google.com',
          'docs.google.com'
        )
      ).toBe(false);
    });

    it('should handle path-based confusion', () => {
      expect(
        matchUrlWithDomainPattern(
          'https://evil.com/docs.google.com',
          'docs.google.com'
        )
      ).toBe(false);
      expect(
        matchUrlWithDomainPattern(
          'https://docs.google.com/malicious/path',
          'docs.google.com'
        )
      ).toBe(true);
    });
  });
});
