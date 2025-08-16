import { describe, it, expect } from 'vitest';
import { JsonParser } from '../src/services/json-parser';

describe('JsonParser', () => {
  describe('parse() - Basic JSON parsing', () => {
    it('should parse valid JSON object', () => {
      const input = ` {{
  "thinking": "I have already navigated to the Wikipedia page for Google and extracted a summary of the content. Now, I need to complete the task by calling the \`done\` action with success set to true and the summary as the text.",
  "evaluation_previous_goal": "Successfully read the extracted content from the file.",
  "memory": "Navigated to the Wikipedia page for Google and have a summary of its content.",
  "next_goal": "Call the \`done\` action to complete the task and provide the summary to the user.",
  "action": [
    {
      "done": {
        "success": true,
        "text": "I have navigated to the Wikipedia page for Google and summarized the content as requested. Google LLC is an American multinational technology company focusing on online advertising, search engine technology, cloud computing, computer software, quantum computing, e-commerce, consumer electronics, and artificial intelligence. It details Google's history from its origins as a research project by Larry Page and Sergey Brin to its IPO and reorganization under Alphabet Inc. The page outlines Google's products and services, including its search engine, advertising platforms, consumer services like Gmail and YouTube, and enterprise offerings like Google Workspace and Google Cloud Platform. It also covers corporate affairs, including business trends, tax avoidance strategies, corporate identity, workplace culture, office locations, infrastructure, environmental initiatives, and philanthropy. Finally, the page addresses criticism and controversies surrounding Google, such as privacy concerns, antitrust issues, and political controversies."
      }
    }
  ]
}}`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        thinking:
          'I have already navigated to the Wikipedia page for Google and extracted a summary of the content. Now, I need to complete the task by calling the `done` action with success set to true and the summary as the text.',
        evaluation_previous_goal:
          'Successfully read the extracted content from the file.',
        memory:
          'Navigated to the Wikipedia page for Google and have a summary of its content.',
        next_goal:
          'Call the `done` action to complete the task and provide the summary to the user.',
        action: [
          {
            done: {
              success: true,
              text: "I have navigated to the Wikipedia page for Google and summarized the content as requested. Google LLC is an American multinational technology company focusing on online advertising, search engine technology, cloud computing, computer software, quantum computing, e-commerce, consumer electronics, and artificial intelligence. It details Google's history from its origins as a research project by Larry Page and Sergey Brin to its IPO and reorganization under Alphabet Inc. The page outlines Google's products and services, including its search engine, advertising platforms, consumer services like Gmail and YouTube, and enterprise offerings like Google Workspace and Google Cloud Platform. It also covers corporate affairs, including business trends, tax avoidance strategies, corporate identity, workplace culture, office locations, infrastructure, environmental initiatives, and philanthropy. Finally, the page addresses criticism and controversies surrounding Google, such as privacy concerns, antitrust issues, and political controversies.",
            },
          },
        ],
      });
    });

    it('should parse valid JSON object', () => {
      const input = '{"name": "test", "value": 123}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should parse valid JSON array', () => {
      const input = '[1, 2, 3, "test"]';
      const result = JsonParser.parse(input);
      expect(result).toEqual([1, 2, 3, 'test']);
    });

    it('should parse nested JSON objects', () => {
      const input = '{"user": {"name": "John", "age": 30}, "active": true}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        user: { name: 'John', age: 30 },
        active: true,
      });
    });

    it('should parse JSON with null values', () => {
      const input = '{"value": null, "empty": ""}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ value: null, empty: '' });
    });

    it('should parse JSON with boolean values', () => {
      const input = '{"isTrue": true, "isFalse": false}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ isTrue: true, isFalse: false });
    });
  });

  describe('parse() - JSON from code fences', () => {
    it('should extract JSON from ```json fences', () => {
      const input = `
Here is some text
\`\`\`json
{"name": "test", "value": 123}
\`\`\`
More text here
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should extract JSON from generic ``` fences', () => {
      const input = `
Some explanation
\`\`\`
{"data": "from generic fence"}
\`\`\`
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({ data: 'from generic fence' });
    });

    it('should handle multiple code fences and pick the first valid one', () => {
      const input = `
\`\`\`
invalid json {
\`\`\`
\`\`\`json
{"valid": true}
\`\`\`
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({ valid: true });
    });

    it('should handle code fences with extra whitespace', () => {
      const input = `
\`\`\`   json
  {"spaced": "content"}
\`\`\`
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({ spaced: 'content' });
    });
  });

  describe('parse() - JSON extraction from text', () => {
    it('should extract first JSON object from mixed text', () => {
      const input =
        'Here is some text {"extracted": true, "number": 42} and more text';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ extracted: true, number: 42 });
    });

    it('should extract first JSON array from mixed text', () => {
      const input = 'Some text [1, 2, {"nested": true}] more text';
      const result = JsonParser.parse(input);
      expect(result).toEqual([1, 2, { nested: true }]);
    });

    it('should prefer object over array when object comes first', () => {
      const input = 'Text {"object": 1} then [1, 2, 3] more';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ object: 1 });
    });

    it('should prefer array over object when array comes first', () => {
      const input = 'Text [1, 2] then {"object": 1} more';
      const result = JsonParser.parse(input);
      expect(result).toEqual([1, 2]);
    });

    it('should handle nested objects and arrays in extraction', () => {
      const input =
        'Text {"items": [1, {"inner": true}], "count": 2} more text';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        items: [1, { inner: true }],
        count: 2,
      });
    });

    it('should handle strings with escaped quotes in extraction', () => {
      const input = 'Text {"message": "He said \\"hello\\"", "ok": true} more';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ message: 'He said "hello"', ok: true });
    });
  });

  describe('parse() - Minor repairs', () => {
    it('should fix double braces at start and end', () => {
      const input = '{{"name": "test", "value": 123}}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle double brackets (nested arrays are valid JSON)', () => {
      const input = '[[1, 2, 3]]';
      const result = JsonParser.parse(input);
      expect(result).toEqual([[1, 2, 3]]);
    });

    it('should escape backticks in JSON strings', () => {
      const input = '{"code": "`console.log(test)`", "type": "javascript"}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        code: '`console.log(test)`',
        type: 'javascript',
      });
    });

    it('should handle some mixed quote scenarios', () => {
      const input = '{"name": \'test\', "value": \'data\'}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 'data' });
    });

    it('should convert single quotes to double quotes for values', () => {
      const input = '{"name": \'test\', "description": \'a simple test\'}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', description: 'a simple test' });
    });

    it('should remove trailing commas before closing brace', () => {
      const input = '{"name": "test", "value": 123,}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should remove trailing commas before closing bracket', () => {
      const input = '[1, 2, 3,]';
      const result = JsonParser.parse(input);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle multiple repair issues that are actually supported', () => {
      const input = '{{"name": "test", "values": [1, 2, 3,], "active": true,}}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        name: 'test',
        values: [1, 2, 3],
        active: true,
      });
    });
  });

  describe('parse() - Complex scenarios', () => {
    it('should handle LLM output with explanation and JSON', () => {
      const input = `
Based on your request, here's the configuration:

\`\`\`json
{
  "settings": {
    "theme": "dark",
    "language": "en"
  },
  "features": ["auth", "notifications"]
}
\`\`\`

This configuration enables the dark theme and English language.
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        settings: {
          theme: 'dark',
          language: 'en',
        },
        features: ['auth', 'notifications'],
      });
    });

    it('should fallback through all strategies', () => {
      const input = `
Some text without proper fences
{"status": "active", "config": {"nested": true}}
More text
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        status: 'active',
        config: { nested: true },
      });
    });

    it('should attempt to handle unbalanced braces but may not always succeed', () => {
      // JsonParser attempts to close unbalanced structures but this particular case fails
      const input =
        'Text {"incomplete": true, "missing": "close" and more text';
      expect(() => JsonParser.parse(input)).toThrow(
        'Unable to parse LLM JSON output:'
      );
    });

    it('should attempt to handle unbalanced brackets but may not always succeed', () => {
      // JsonParser attempts to close unbalanced structures but this particular case fails
      const input = 'Text [1, 2, 3 and more text';
      expect(() => JsonParser.parse(input)).toThrow(
        'Unable to parse LLM JSON output:'
      );
    });

    it('should work with TypeScript generic types', () => {
      interface TestInterface {
        name: string;
        count: number;
      }
      const input = '{"name": "typed", "count": 42}';
      const result = JsonParser.parse<TestInterface>(input);
      expect(result.name).toBe('typed');
      expect(result.count).toBe(42);
    });
  });

  describe('parse() - Edge cases and error handling', () => {
    it('should handle empty string', () => {
      expect(() => JsonParser.parse('')).toThrow(
        'Unable to parse LLM JSON output:'
      );
    });

    it('should handle whitespace only', () => {
      expect(() => JsonParser.parse('   \n\t   ')).toThrow(
        'Unable to parse LLM JSON output:'
      );
    });

    it('should handle text without any JSON', () => {
      expect(() =>
        JsonParser.parse('This is just plain text without any JSON content')
      ).toThrow('Unable to parse LLM JSON output:');
    });

    it('should handle malformed JSON that cannot be repaired', () => {
      expect(() =>
        JsonParser.parse('{"incomplete": "json" missing quotes and braces')
      ).toThrow('Unable to parse LLM JSON output:');
    });

    it('should handle JSON with unescaped quotes that break parsing', () => {
      // This is a case where the repairs might not be sufficient
      const problematic = '{"message": "He said "hello" to me"}';
      expect(() => JsonParser.parse(problematic)).toThrow(
        'Unable to parse LLM JSON output:'
      );
    });

    it('should handle arrays and objects with no content', () => {
      expect(JsonParser.parse('{}')).toEqual({});
      expect(JsonParser.parse('[]')).toEqual([]);
    });

    it('should handle very nested structures', () => {
      const nested = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      };
      const input = JSON.stringify(nested);
      const result = JsonParser.parse(input);
      expect(result).toEqual(nested);
    });

    it('should handle large arrays', () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => i);
      const input = JSON.stringify(largeArray);
      const result = JsonParser.parse(input);
      expect(result).toEqual(largeArray);
    });

    it('should handle strings with special characters', () => {
      const input = '{"special": "áéíóú ñ ç § € ¥ © ® ™ ← → ↑ ↓"}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        special: 'áéíóú ñ ç § € ¥ © ® ™ ← → ↑ ↓',
      });
    });

    it('should handle strings with newlines and tabs', () => {
      const input = '{"multiline": "line1\\nline2\\tindented"}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ multiline: 'line1\nline2\tindented' });
    });
  });

  describe('parse() - Additional repair scenarios', () => {
    it('should handle backticks in JSON values that need escaping', () => {
      // This tests the backtick escaping repair functionality
      const input =
        '{"command": "`npm install`", "description": "Install dependencies"}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        command: '`npm install`',
        description: 'Install dependencies',
      });
    });

    it('should handle JSON with extra whitespace and newlines', () => {
      const input = `
      {
        "name": "test",
        "value": 123
      }
      `;
      const result = JsonParser.parse(input);
      expect(result).toEqual({ name: 'test', value: 123 });
    });

    it('should handle single quote to double quote conversion for values', () => {
      const input = '{"message": \'Hello world\', "type": \'greeting\'}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ message: 'Hello world', type: 'greeting' });
    });

    it('should handle arrays with trailing commas', () => {
      const input = '{"items": [1, 2, 3,], "count": 3}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({ items: [1, 2, 3], count: 3 });
    });

    it('should handle nested objects with trailing commas', () => {
      const input = '{"user": {"name": "John", "age": 30,}, "active": true,}';
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        user: { name: 'John', age: 30 },
        active: true,
      });
    });
  });

  describe('parse() - Real-world LLM scenarios', () => {
    it('should handle ChatGPT-style JSON response', () => {
      const input = `
I'll help you create that configuration. Here's the JSON:

\`\`\`json
{
  "api": {
    "endpoint": "https://api.example.com",
    "timeout": 5000,
    "retries": 3
  },
  "features": {
    "caching": true,
    "logging": "debug"
  }
}
\`\`\`

This configuration sets up the API with proper timeout and retry settings.
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        api: {
          endpoint: 'https://api.example.com',
          timeout: 5000,
          retries: 3,
        },
        features: {
          caching: true,
          logging: 'debug',
        },
      });
    });

    it('should handle Claude-style JSON response with thinking', () => {
      const input = `
Let me think about this request...

The user wants a configuration object for their application. I should provide:
1. Database settings
2. Authentication configuration
3. Feature flags

Here's the JSON configuration:

\`\`\`json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "name": "myapp"
  },
  "auth": {
    "provider": "jwt",
    "expiry": "24h"
  },
  "features": {
    "darkMode": true,
    "notifications": false
  }
}
\`\`\`
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        database: {
          host: 'localhost',
          port: 5432,
          name: 'myapp',
        },
        auth: {
          provider: 'jwt',
          expiry: '24h',
        },
        features: {
          darkMode: true,
          notifications: false,
        },
      });
    });

    it('should handle JSON with code snippets as values', () => {
      const input = `
\`\`\`json
{
  "template": "function hello() { return 'world'; }",
  "style": ".btn { background: #007bff; }",
  "config": {
    "script": "npm run build && npm start",
    "env": "NODE_ENV=production"
  }
}
\`\`\`
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        template: "function hello() { return 'world'; }",
        style: '.btn { background: #007bff; }',
        config: {
          script: 'npm run build && npm start',
          env: 'NODE_ENV=production',
        },
      });
    });

    it('should handle mixed response with both explanation and inline JSON', () => {
      const input = `
The API response should be structured as {"status": "success", "data": {"items": [1, 2, 3]}} to ensure compatibility with the frontend components.
`;
      const result = JsonParser.parse(input);
      expect(result).toEqual({
        status: 'success',
        data: { items: [1, 2, 3] },
      });
    });
  });
});
