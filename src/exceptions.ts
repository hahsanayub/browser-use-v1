export class LLMException extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly detail: string
  ) {
    super(`Error ${statusCode}: ${detail}`);
    this.name = 'LLMException';
  }
}

export class URLNotAllowedError extends Error {
  constructor(
    public readonly url: string,
    public readonly allowedDomains: string[]
  ) {
    super(
      `URL "${url}" is not allowed. ` +
        `Only domains matching ${JSON.stringify(allowedDomains)} are permitted. ` +
        `This is enforced because sensitive_data was provided to Agent.`
    );
    this.name = 'URLNotAllowedError';
  }
}
