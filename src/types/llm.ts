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
  };
  /** Model used for generation */
  model?: string;
  /** Response metadata */
  metadata?: Record<string, any>;
}

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
}
