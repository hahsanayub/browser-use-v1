import type { BrowserSession } from '../browser/session.js';
import type { MouseButton } from '../browser/events.js';

export class Mouse {
  constructor(
    private readonly browser_session: BrowserSession,
    private readonly pageRef: any | null = null
  ) {}

  private async _page() {
    if (this.pageRef) {
      return this.pageRef;
    }
    return this.browser_session.get_current_page();
  }

  async click(
    x: number,
    y: number,
    options: {
      button?: MouseButton;
      click_count?: number;
    } = {}
  ) {
    const button = options.button ?? 'left';
    await this.browser_session.click_coordinates(x, y, { button });
  }

  async move(x: number, y: number) {
    const page = await this._page();
    if (!page?.mouse?.move) {
      return;
    }
    await page.mouse.move(x, y);
  }

  async down(options: { button?: MouseButton } = {}) {
    const page = await this._page();
    if (!page?.mouse?.down) {
      return;
    }
    await page.mouse.down({ button: options.button ?? 'left' });
  }

  async up(options: { button?: MouseButton } = {}) {
    const page = await this._page();
    if (!page?.mouse?.up) {
      return;
    }
    await page.mouse.up({ button: options.button ?? 'left' });
  }
}
