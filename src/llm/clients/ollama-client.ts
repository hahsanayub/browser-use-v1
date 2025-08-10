/**
 * Ollama LLM client implementation
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMClient } from '../base-client';
import type { LLMMessage, LLMResponse, LLMRequestOptions, LLMClientConfig } from '../../types/llm';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content?: string;
  images?: Array<string | { value: string | ArrayBufferLike }>;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>; // best-effort; Ollama supports tool calls in some builds
}

interface OllamaChatResponse {
  message: { role: string; content: string | null };
}

export class OllamaClient extends BaseLLMClient {
  private httpClient: AxiosInstance;
  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  constructor(config: LLMClientConfig) {
    super(config);
    this.httpClient = axios.create({
      baseURL: config.baseUrl || 'http://localhost:11434',
      timeout: config.timeout || 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private extractTextContent(content: any): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const part of content as any[]) {
      if (part?.type === 'text') parts.push(part.text);
      else if (part?.type === 'refusal') parts.push(`[Refusal] ${part.refusal}`);
    }
    return parts.join('\n');
  }

  private extractImages(content: any): Array<string> {
    if (content == null || typeof content === 'string') return [];
    const images: string[] = [];
    for (const part of content as any[]) {
      if (part?.type === 'image_url') {
        const url: string = part.image_url.url;
        images.push(url);
      }
    }
    return images;
  }

  async generateResponse(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
    this.validateMessages(messages);
    const requestOptions = this.mergeOptions(options);
    const startTime = Date.now();

    const ollamaMessages: OllamaMessage[] = messages.map((m) => {
      const msg: OllamaMessage = { role: m.role };
      const text = this.extractTextContent(m.content as any);
      if (text) msg.content = text;
      const imgs = this.extractImages(m.content as any);
      if (imgs.length > 0) msg.images = imgs;
      return msg;
    });

    const body: Record<string, any> = {
      model: this.config.model,
      messages: ollamaMessages,
      stream: requestOptions.stream ?? false,
    };

    // Structured output
    if (requestOptions.responseFormat) {
      if (requestOptions.responseFormat.type === 'json_schema') {
        body.format = requestOptions.responseFormat.schema;
      } else if (requestOptions.responseFormat.type === 'json_object') {
        body.format = 'json';
      }
    }

    try {
      const maxRetries = typeof this.config.maxRetries === 'number' ? this.config.maxRetries : 0;
      let attempt = 0;
      let lastError: any;
      let response: { data: OllamaChatResponse } | undefined;
      while (attempt <= maxRetries) {
        try {
          // Prefer chat endpoint if available
          response = await this.httpClient.post<OllamaChatResponse>(
            '/api/chat',
            body,
            requestOptions.timeout ? { timeout: requestOptions.timeout } : undefined
          );
          break;
        } catch (err: any) {
          // If chat endpoint is not found, fall back to generate
          const status = err?.response?.status;
          const isNotFound = status === 404 || (typeof err?.message === 'string' && err.message.includes('/api/chat'));
          if (isNotFound) {
            try {
              const generateBody: Record<string, any> = {
                model: this.config.model,
                prompt: ollamaMessages.map(m => `${m.role}: ${m.content ?? ''}`).join('\n'),
                stream: requestOptions.stream ?? false,
              };
              const genResp = await this.httpClient.post<{ response: string }>(
                '/api/generate',
                generateBody,
                requestOptions.timeout ? { timeout: requestOptions.timeout } : undefined
              );
              const requestTime = Date.now() - startTime;
              const content = (genResp.data as any)?.response ?? '';
              const llmResponse: LLMResponse = {
                content,
                usage: undefined,
                model: this.config.model,
                metadata: { requestTime, endpoint: 'generate' },
              };
              this.logMetrics(llmResponse, requestTime, messages.length);
              return llmResponse;
            } catch (genErr: any) {
              lastError = genErr;
            }
          } else {
            lastError = err;
          }
          if (attempt < maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
            await this.sleep(backoffMs);
            attempt += 1;
            continue;
          }
          throw lastError;
        }
      }
      if (!response) throw lastError || new Error('Ollama request failed without response');

      const requestTime = Date.now() - startTime;
      const content = response.data?.message?.content ?? '';
      const llmResponse: LLMResponse = {
        content,
        usage: undefined,
        model: this.config.model,
        metadata: { requestTime },
      };
      this.logMetrics(llmResponse, requestTime, messages.length);
      return llmResponse;
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw this.handleError(error, 'Ollama server not found');
      }
      throw this.handleError(error, 'Ollama request failed');
    }
  }

  async validateConfig(): Promise<boolean> {
    try {
      await this.httpClient.get('/');
      return true;
    } catch (e) {
      return false;
    }
  }

  getSupportedModels(): string[] {
    return [this.config.model];
  }
}


