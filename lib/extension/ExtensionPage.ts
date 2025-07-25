/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import { Page, Frame, BrowserContext } from "playwright";
import { ExtensionContext } from "./ExtensionContext";
import { ExtensionWebSocket } from "./ExtensionWebSocket";

export class ExtensionPage {
  private _context: ExtensionContext;
  private ws: ExtensionWebSocket;
  private sessionId: string;
  private currentUrl: string = "about:blank";
  private _viewportSize = { width: 1280, height: 720 };
  private initScripts: string[] = [];

  constructor(
    context: ExtensionContext,
    ws: ExtensionWebSocket,
    sessionId: string,
  ) {
    this._context = context;
    this.ws = ws;
    this.sessionId = sessionId;
  }

  async init(): Promise<void> {
    // Page is ready after session creation
  }

  async goto(url: string, _options?: Record<string, unknown>): Promise<null> {
    await this.ws.sendAction(this.sessionId, {
      type: "navigate",
      url,
    });
    this.currentUrl = url;
    return null;
  }

  url(): string {
    return this.currentUrl;
  }

  async screenshot(_options?: Record<string, unknown>): Promise<Buffer> {
    const result = await this.ws.sendAction(this.sessionId, {
      type: "screenshot",
    });

    // Convert base64 to buffer
    const base64 = result.screenshot.replace(/^data:image\/png;base64,/, "");
    return Buffer.from(base64, "base64");
  }

  async click(
    selector: string,
    _options?: Record<string, unknown>,
  ): Promise<void> {
    // First, find element coordinates
    const element = await this.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }

    const box = await element.boundingBox();
    if (!box) {
      throw new Error(`Element has no bounding box: ${selector}`);
    }

    await this.ws.sendAction(this.sessionId, {
      type: "click",
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
  }

  async type(
    selector: string,
    text: string,
    _options?: Record<string, unknown>,
  ): Promise<void> {
    // Focus element first
    await this.click(selector);

    // Then type
    await this.ws.sendAction(this.sessionId, {
      type: "type",
      text,
    });
  }

  async evaluate<T = unknown>(
    pageFunction: string | ((...args: unknown[]) => unknown),
    ...args: unknown[]
  ): Promise<T> {
    const script =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`
        : pageFunction;

    const result = await this.ws.sendAction(this.sessionId, {
      type: "evaluate",
      script,
    });

    return result.result;
  }

  async evaluateOnNewDocument(script: string): Promise<void> {
    this.initScripts.push(script);
    // Apply to current page
    await this.evaluate(script);
  }

  async $(selector: string): Promise<any> {
    const exists = await this.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return el ? true : false;
    }, selector);

    if (!exists) return null;

    // Return a mock element handle
    return {
      boundingBox: async () => {
        return this.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          };
        }, selector);
      },
      click: async () => this.click(selector),
      type: async (text: string) => this.type(selector, text),
      evaluate: async (
        fn: (element: Element, ...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => {
        return this.evaluate(
          (sel: string, fnStr: string, ...fnArgs: unknown[]) => {
            const el = document.querySelector(sel);
            const func = new Function(
              "element",
              ...fnArgs.map((_, i) => `arg${i}`),
              fnStr,
            );
            return func(el, ...fnArgs);
          },
          selector,
          fn.toString(),
          ...args,
        );
      },
    };
  }

  async waitForLoadState(
    _state?: string,
    _options?: Record<string, unknown>,
  ): Promise<void> {
    // Extension handles page load internally
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async waitForSelector(
    selector: string,
    options?: { timeout?: number; state?: string },
  ): Promise<any> {
    const timeout = options?.timeout || 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const element = await this.$(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (options?.state === "hidden") {
      return null;
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async setViewportSize(size: {
    width: number;
    height: number;
  }): Promise<void> {
    this._viewportSize = size;
    // Extension tabs adapt to window size automatically
  }

  mainFrame(): any {
    // Return this page as a frame
    return this;
  }

  async content(): Promise<string> {
    return this.evaluate(() => document.documentElement.outerHTML);
  }

  async close(): Promise<void> {
    await this.ws.closeSession(this.sessionId);
  }

  context(): any {
    return this._context;
  }

  isClosed(): boolean {
    return !this.ws.isConnected();
  }

  viewportSize(): { width: number; height: number } {
    return this._viewportSize;
  }

  // Stub other required Page methods
  get mouse(): any {
    return {
      move: async (x: number, y: number) => {
        await this.ws.sendAction(this.sessionId, { type: "move", x, y });
      },
      click: async (x: number, y: number) => {
        await this.ws.sendAction(this.sessionId, { type: "click", x, y });
      },
    };
  }

  get keyboard(): any {
    return {
      type: async (text: string) => {
        await this.ws.sendAction(this.sessionId, { type: "type", text });
      },
      press: async (key: string) => {
        await this.ws.sendAction(this.sessionId, { type: "keypress", key });
      },
    };
  }
}
