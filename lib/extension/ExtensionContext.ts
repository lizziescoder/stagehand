/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import { BrowserContext, Page, Cookie } from "playwright";
import { ExtensionPage } from "./ExtensionPage";
import { ExtensionWebSocket } from "./ExtensionWebSocket";
import { ExtensionBrowser } from "./ExtensionBrowser";
import { CDPSession } from "./ExtensionTypes";

export class ExtensionContext {
  private _pages: ExtensionPage[] = [];
  private _browser: ExtensionBrowser;
  private ws: ExtensionWebSocket;
  private _cookies: Cookie[] = [];

  constructor(browser: ExtensionBrowser, ws: ExtensionWebSocket) {
    this._browser = browser;
    this.ws = ws;
  }

  async newPage(): Promise<any> {
    const sessionId = await this.ws.createSession();
    const page = new ExtensionPage(this, this.ws, sessionId);
    await page.init();
    this._pages.push(page);
    return page;
  }

  pages(): any[] {
    return this._pages;
  }

  async addCookies(cookies: Cookie[]): Promise<void> {
    this._cookies.push(...cookies);
    // Send cookies to extension if needed
  }

  async newCDPSession(_page: any): Promise<any> {
    // Return a mock CDP session that handles download behavior
    return {
      send: async (method: string, _params: Record<string, unknown>) => {
        if (method === "Browser.setDownloadBehavior") {
          // Handle download behavior
          return;
        }
        // Handle other CDP methods as needed
      },
    };
  }

  async addInitScript(script: { content: string }): Promise<void> {
    // Store init scripts to inject into new pages
    for (const page of this._pages) {
      await page.evaluateOnNewDocument(script.content);
    }
  }

  async close(): Promise<void> {
    for (const page of this._pages) {
      await page.close();
    }
  }

  browser(): any {
    return this._browser;
  }
}
