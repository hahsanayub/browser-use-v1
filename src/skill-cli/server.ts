import { Request, Response } from './protocol.js';
import { SessionRegistry } from './sessions.js';

export interface SkillCliServerOptions {
  registry?: SessionRegistry;
}

export class SkillCliServer {
  readonly registry: SessionRegistry;

  constructor(options: SkillCliServerOptions = {}) {
    this.registry = options.registry ?? new SessionRegistry();
  }

  private async _handle_browser_action(
    action: string,
    sessionName: string,
    params: Record<string, unknown>
  ) {
    const session = await this.registry.get_or_create_session(sessionName);
    const browser_session = session.browser_session;

    if (action === 'open') {
      const url = String(params.url ?? '');
      if (!url) {
        throw new Error('Missing url');
      }
      await browser_session.navigate_to(url);
      return { url };
    }

    if (action === 'click') {
      const index = Number(params.index);
      if (!Number.isFinite(index)) {
        throw new Error('Missing index');
      }
      const node = await browser_session.get_dom_element_by_index(index);
      if (!node) {
        return {
          error: `Element index ${index} not found - page may have changed`,
        };
      }
      await browser_session._click_element_node(node);
      return { clicked: index };
    }

    if (action === 'type') {
      const text = String(params.text ?? '');
      await browser_session.send_keys(text);
      return { typed: text };
    }

    if (action === 'state') {
      const state = await browser_session.get_browser_state_with_recovery({
        include_screenshot: false,
      });
      return {
        url: state.url,
        title: state.title,
        tabs: state.tabs,
        llm_representation: state.llm_representation(),
      };
    }

    if (action === 'close') {
      await this.registry.close_session(sessionName);
      return { closed: sessionName };
    }

    if (action === 'sessions') {
      const sessions = this.registry.list_sessions();
      return { sessions, count: sessions.length };
    }

    throw new Error(`Unknown action: ${action}`);
  }

  async handle_request(request: Request | string) {
    const req =
      typeof request === 'string' ? Request.from_json(request) : request;
    try {
      const data = await this._handle_browser_action(
        req.action,
        req.session,
        req.params
      );
      if (data && typeof data === 'object' && 'error' in data) {
        return new Response({
          id: req.id,
          success: false,
          data: null,
          error: String((data as any).error),
        });
      }
      return new Response({
        id: req.id,
        success: true,
        data,
      });
    } catch (error) {
      return new Response({
        id: req.id,
        success: false,
        error: String((error as Error)?.message ?? error),
      });
    }
  }
}
