/**
 * LLM-related type definitions
 */

export interface LLMMessage {
  /** Role of the message sender */
  role: 'system' | 'user' | 'assistant';
  /** Content of the message */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, any>;
}

export interface LLMResponse {
  /** Generated content */
  content: string;
  /** Token usage information */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Optional reasoning tokens for models that separate them */
    reasoningTokens?: number;
    /** Optional cached tokens when API indicates cache hits */
    cachedTokens?: number;
    /** OpenAI: cached prompt tokens (prompt_tokens_details.cached_tokens) */
    promptCachedTokens?: number | null;
    /** Anthropic: cache creation input tokens */
    promptCacheCreationTokens?: number | null;
    /** Placeholder for future: prompt image tokens if provider exposes */
    promptImageTokens?: number | null;
  };
  /** Model used for generation */
  model?: string;
  /** Response metadata */
  metadata?: Record<string, any>;
}

export type JSONSchema = Record<string, any>;

export type LLMResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: JSONSchema; name?: string; strict?: boolean };

export interface LLMRequestOptions {
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for response generation */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Whether to stream the response */
  stream?: boolean;
  /** nucleus sampling */
  topP?: number;
  /** frequency penalty */
  frequencyPenalty?: number;
  /** presence penalty */
  presencePenalty?: number;
  /** seed for reproducibility (when supported) */
  seed?: number;
  /** response format enforcement */
  responseFormat?: LLMResponseFormat;
  /** service tier override (OpenAI) */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale';
  /** reasoning effort for O-series models (OpenAI) */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** when using json_schema, optionally also embed schema into system prompt */
  addSchemaToSystemPrompt?: boolean;
  /** Google Gemini: thinking budget (token budget for internal thoughts) */
  thinkingBudget?: number;
}

export interface LLMClientConfig {
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseUrl?: string;
  /** Default model to use */
  model: string;
  /** Default request options */
  defaultOptions?: LLMRequestOptions;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Max automatic retries on failures (if supported by client) */
  maxRetries?: number;
  /** Organization (OpenAI) */
  organization?: string;
  /** Project (OpenAI) */
  project?: string;
  /** Default service tier (OpenAI) */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority' | 'scale';
}
