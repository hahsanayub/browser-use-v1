import { BrowserProfile } from './profile.js';
import { BrowserSession } from './session.js';

export type BrowserConfig = BrowserProfile;
export type BrowserContextConfig = BrowserProfile;
export const Browser = BrowserSession;

export { BrowserProfile };
export { BrowserSession };
