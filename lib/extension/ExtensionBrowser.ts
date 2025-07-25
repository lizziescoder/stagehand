/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import { Browser, BrowserContext } from "playwright";
import { ExtensionContext } from "./ExtensionContext";
import { ExtensionWebSocket } from "./ExtensionWebSocket";

export class ExtensionBrowser {
  private _contexts: ExtensionContext[] = [];
  private ws: ExtensionWebSocket;
  private connectionId: string;

  constructor(connectionId: string, websocketUrl: string) {
    this.connectionId = connectionId;
    this.ws = new ExtensionWebSocket(websocketUrl, connectionId);
  }

  async connect(): Promise<void> {
    await this.ws.connect();
  }

  contexts(): any[] {
    return this._contexts;
  }

  async newContext(): Promise<any> {
    const context = new ExtensionContext(this, this.ws);
    this._contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    for (const context of this._contexts) {
      await context.close();
    }
    await this.ws.disconnect();
  }

  isConnected(): boolean {
    return this.ws.isConnected();
  }

  // Stub other Browser methods as needed
  version(): string {
    return "Extension/1.0";
  }
}
