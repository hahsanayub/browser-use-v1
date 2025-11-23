export class ModelError extends Error {}

export class ModelProviderError extends ModelError {
  constructor(
    message: string,
    public statusCode = 502,
    public model: string | null = null
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export class ModelRateLimitError extends ModelProviderError {
  constructor(message: string, statusCode = 429, model: string | null = null) {
    super(message, statusCode, model);
    this.name = 'ModelRateLimitError';
  }
}
