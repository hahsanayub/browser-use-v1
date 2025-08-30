/**
 * Custom error types for browser-use
 */

/**
 * Browser-specific error class for browser operation failures
 */
export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserError';
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BrowserError);
    }
  }
}

/**
 * Network-related error class
 */
export class NetworkError extends BrowserError {
  constructor(
    message: string,
    public readonly url?: string
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Element not found error
 */
export class ElementNotFoundError extends BrowserError {
  constructor(
    message: string,
    public readonly selector?: string
  ) {
    super(message);
    this.name = 'ElementNotFoundError';
  }
}

/**
 * Check if an error message contains network-related errors
 */
export function isNetworkError(errorMessage: string): boolean {
  const networkErrors = [
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_TIMED_OUT',
    'ERR_NETWORK_CHANGED',
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_ABORTED',
    'ERR_SOCKET_NOT_CONNECTED',
    'ERR_NETWORK_IO_SUSPENDED',
    'net::',
    'NS_ERROR_',
  ];

  return networkErrors.some((err) => errorMessage.includes(err));
}

/**
 * Extract user-friendly message from network error
 */
export function getNetworkErrorMessage(
  errorMessage: string,
  url?: string
): string {
  if (errorMessage.includes('ERR_NAME_NOT_RESOLVED')) {
    return `Could not resolve domain name${url ? ` for ${url}` : ''}. Please check the URL.`;
  }
  if (errorMessage.includes('ERR_INTERNET_DISCONNECTED')) {
    return 'No internet connection available.';
  }
  if (errorMessage.includes('ERR_CONNECTION_REFUSED')) {
    return `Connection refused${url ? ` by ${url}` : ''}. The server may be down.`;
  }
  if (
    errorMessage.includes('ERR_CONNECTION_TIMED_OUT') ||
    errorMessage.includes('ERR_TIMED_OUT')
  ) {
    return `Connection timed out${url ? ` to ${url}` : ''}. The server is not responding.`;
  }
  if (errorMessage.includes('ERR_CONNECTION_RESET')) {
    return `Connection was reset${url ? ` by ${url}` : ''}. Please try again.`;
  }

  return `Network error occurred${url ? ` while accessing ${url}` : ''}: ${errorMessage}`;
}
