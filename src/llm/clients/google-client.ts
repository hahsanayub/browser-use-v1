/**
 * Google Gemini client implementation (HTTP via google genai REST is not used here;
 * this client models a minimal surface compatible with our BaseLLMClient).
 */

import axios, { AxiosInstance } from 'axios';
import { BaseLLMClient } from '../base-client';
import type {
  LLMMessage,
  LLMResponse,
  LLMRequestOptions,
  LLMClientConfig,
  LLMContentPart,
} from '../../types/llm';

interface GooglePart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GoogleContent {
  role?: 'user' | 'model' | 'system';
  parts: GooglePart[];
}

interface GenerateContentRequest {
  contents: GoogleContent[];
  systemInstruction?: { role: 'system'; parts: GooglePart[] };
  generationConfig?: Record<string, any>;
}

interface GenerateContentResponseUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number | null;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GooglePart[] };
  }>;
  usageMetadata?: GenerateContentResponseUsage;
}

export class GoogleClient extends BaseLLMClient {
  private httpClient: AxiosInstance;

  constructor(config: LLMClientConfig) {
    super(config);
    // Base URL should point to Google's Generative Language REST API (e.g.,
    // https://generativelanguage.googleapis.com/v1beta). We authenticate using
    // API key header per REST spec (not OAuth Bearer).
    this.httpClient = axios.create({
      baseURL: config.baseUrl || '',
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.apiKey || '',
      },
    });
  }

  /**
   * Convert our content format to Google Parts format
   */
  private convertContentToParts(content: string | LLMContentPart[]): GooglePart[] {
    if (typeof content === 'string') {
      return [{ text: content }];
    }

    const parts: GooglePart[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ text: part.text });
      } else if (part.type === 'image') {
        // Convert data URI to inline data format for Google
        const url = part.imageUrl.url;
        if (url.startsWith('data:image/')) {
          const [mimeTypePart, base64Data] = url.split(',');
          const mimeType = mimeTypePart.split(':')[1].split(';')[0];
          parts.push({
            inlineData: {
              mimeType,
              data: base64Data,
            },
          });
        } else {
          // For HTTP URLs, Google requires inline data, so we log a warning
          // In a production system, you'd want to fetch and convert the image
          this.logger.warn('Google Gemini requires inline data for images, HTTP URLs not directly supported', {
            url,
          });
        }
      }
    }

    return parts;
  }

  private serializeMessages(messages: LLMMessage[]): {
    contents: GoogleContent[];
    system?: GoogleContent;
  } {
    const contents: GoogleContent[] = [];
    let system: GoogleContent | undefined;
    for (const m of messages) {
      if (m.role === 'system') {
        const systemParts: GooglePart[] = this.convertContentToParts(m.content);
        system = { role: 'user', parts: systemParts } as any; // Google expects system separately; placeholder
        continue;
      }
      const parts: GooglePart[] = this.convertContentToParts(m.content);
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
    const generationConfig: Record<string, any> = {};
    if (requestOptions.temperature != null)
      generationConfig.temperature = requestOptions.temperature;
    if (requestOptions.topP != null)
      generationConfig.topP = requestOptions.topP;
    if (requestOptions.seed != null)
      generationConfig.seed = requestOptions.seed;
    if (requestOptions.maxTokens != null)
      generationConfig.maxOutputTokens = requestOptions.maxTokens;
    // Avoid sending undocumented fields that may cause 400s

    const req: GenerateContentRequest = {
      contents,
      generationConfig,
    };
    if (system) {
      req.systemInstruction = { role: 'system', parts: system.parts };
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
        data.usageMetadata?.promptTokensDetails
          ?.filter((d) => (d.modality || '').toUpperCase() === 'IMAGE')
          .reduce((sum, d) => sum + (d.tokenCount || 0), 0) || 0;

      const primaryText =
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join('\n') || '';

      const llm: LLMResponse = {
        content: primaryText,
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount || 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: data.usageMetadata?.totalTokenCount || 0,
          promptCachedTokens:
            data.usageMetadata?.cachedContentTokenCount ?? null,
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
    // No universal validation endpoint; assume baseUrl configured or use SDK externally.
    return true;
  }
}
