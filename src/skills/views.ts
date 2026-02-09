export type SkillParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'cookie';

export interface SkillParameterSchema {
  name: string;
  type: SkillParameterType;
  required?: boolean | null;
  description?: string | null;
}

export interface SkillDefinition {
  id: string;
  title: string;
  description: string;
  parameters: SkillParameterSchema[];
  output_schema?: Record<string, unknown> | null;
}

export interface SkillExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string | null;
  latency_ms?: number | null;
}

export interface BrowserCookie {
  name: string;
  value: string;
}

export interface ExecuteSkillInput {
  skill_id: string;
  parameters: Record<string, unknown>;
  cookies: BrowserCookie[];
}

export interface SkillService {
  get_all_skills(): Promise<SkillDefinition[]>;
  execute_skill(input: ExecuteSkillInput): Promise<SkillExecutionResult>;
  close?(): Promise<void> | void;
}

export class MissingCookieException extends Error {
  public cookie_name: string;
  public cookie_description: string;

  constructor(cookie_name: string, cookie_description: string) {
    super(`Missing required cookie '${cookie_name}': ${cookie_description}`);
    this.name = 'MissingCookieException';
    this.cookie_name = cookie_name;
    this.cookie_description = cookie_description;
  }
}
