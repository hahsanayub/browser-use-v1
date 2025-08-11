/**
 * Google Gemini client implementation (HTTP via google genai REST is not used here;
 * this client models a minimal surface compatible with our BaseLLMClient).
 *
 * Note: For full feature parity with Python (genai SDK), consider adding official SDK.
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
} from '../../types/llm';

interface GooglePart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

interface GenerateContentRequest {
  contents: GoogleContent[];
  system_instruction?: { role: 'system'; parts: GooglePart[] };
  generation_config?: Record<string, any>;
}

interface GenerateContentResponseUsage {
  prompt_token_count?: number;
  candidates_token_count?: number;
  total_token_count?: number;
  cached_content_token_count?: number;
  prompt_tokens_details?: Array<{ modality: string; token_count?: number }>;
  thoughts_token_count?: number;
}

interface GenerateContentResponse {
  text?: string;
  usage_metadata?: GenerateContentResponseUsage;
}

export class GoogleClient extends BaseLLMClient {
  private httpClient: AxiosInstance;

  constructor(config: LLMClientConfig) {
    super(config);
    // Base URL should be provided for REST proxy that forwards to Google GenAI.
    // Otherwise, user should prefer the official SDK.
    this.httpClient = axios.create({
      baseURL: config.baseUrl || '',
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  }

  private serializeMessages(messages: LLMMessage[]): {
    contents: GoogleContent[];
    system?: GoogleContent;
  } {
    const contents: GoogleContent[] = [];
    let system: GoogleContent | undefined;
    for (const m of messages) {
      if (m.role === 'system') {
        const systemParts: GooglePart[] = [{ text: m.content }];
        system = { role: 'user', parts: systemParts } as any; // Google expects system separately; placeholder
        continue;
      }
      const parts: GooglePart[] = [{ text: m.content }];
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts });
    }
    return { contents, system };
  }

  async generateResponse(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    this.validateMessages(messages);
    const requestOptions = this.mergeOptions(options);
    const start = Date.now();

    const { contents, system } = this.serializeMessages(messages);
    const generation_config: Record<string, any> = {};
    if (requestOptions.temperature != null)
      generation_config.temperature = requestOptions.temperature;
    if (requestOptions.topP != null)
      generation_config.top_p = requestOptions.topP;
    if (requestOptions.seed != null)
      generation_config.seed = requestOptions.seed;
    if (requestOptions.maxTokens != null)
      generation_config.max_output_tokens = requestOptions.maxTokens;
    if (requestOptions.thinkingBudget != null)
      generation_config.thinking_config = {
        thinking_budget: requestOptions.thinkingBudget,
      };

    const req: GenerateContentRequest = {
      contents,
      generation_config,
    };
    if (system) {
      req.system_instruction = { role: 'system', parts: system.parts };
    }

    try {
      const url = `/models/${encodeURIComponent(this.config.model)}:generateContent`;
      const res = await this.httpClient.post<GenerateContentResponse>(
        url,
        req,
        requestOptions.timeout ? { timeout: requestOptions.timeout } : undefined
      );
      const data = res.data;
      const time = Date.now() - start;

      const imageTokens =
        data.usage_metadata?.prompt_tokens_details
          ?.filter((d) => d.modality?.toUpperCase() === 'IMAGE')
          .reduce((s, d) => s + (d.token_count || 0), 0) || 0;

      const llm: LLMResponse = {
        content: data.text || '',
        usage: {
          promptTokens: data.usage_metadata?.prompt_token_count || 0,
          completionTokens:
            (data.usage_metadata?.candidates_token_count || 0) +
            (data.usage_metadata?.thoughts_token_count || 0),
          totalTokens: data.usage_metadata?.total_token_count || 0,
          promptCachedTokens:
            data.usage_metadata?.cached_content_token_count ?? null,
          promptCacheCreationTokens: null,
          promptImageTokens: imageTokens || null,
        },
        model: this.config.model,
        metadata: { requestTime: time },
      };
      this.logMetrics(llm, time, messages.length);
      return llm;
    } catch (error: any) {
      const msg =
        error?.response?.data?.error?.message ||
        error.message ||
        'Google request failed';
      throw this.handleError(error, msg);
    }
  }

  async validateConfig(): Promise<boolean> {
    try {
      // No universal validation endpoint; assume baseUrl configured or use SDK externally.
      return true;
    } catch {
      return false;
    }
  }
}
