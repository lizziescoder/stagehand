/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
import WebSocket from "ws";
import { ExtensionMessage, MessageHandler } from "./ExtensionTypes";

export class ExtensionWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private connectionId: string;
  private connected: boolean = false;
  private messageHandlers = new Map<string, MessageHandler>();
  private sessionCounter = 0;

  constructor(url: string, connectionId: string) {
    this.url = url;
    this.connectionId = connectionId;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        this.connected = true;
        // Send initial connection message
        this.send({
          type: "extension.connect",
          connectionId: this.connectionId,
        });
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error("Failed to parse WebSocket message:", error);
        }
      });

      this.ws.on("error", (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      });

      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  private handleMessage(message: ExtensionMessage): void {
    const { type, sessionId, payload } = message;

    // Handle specific message types
    const key = `${type}.${sessionId || "global"}`;
    const handler = this.messageHandlers.get(key);
    if (handler) {
      handler(payload);
      this.messageHandlers.delete(key);
    }
  }

  async createSession(url?: string): Promise<string> {
    const sessionId = `session-${Date.now()}-${++this.sessionCounter}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout creating session"));
      }, 10000);

      this.messageHandlers.set(`session.ready.${sessionId}`, () => {
        clearTimeout(timeout);
        resolve(sessionId);
      });

      this.send({
        sessionId,
        type: "session.create",
        payload: { url },
      });
    });
  }

  async sendAction(sessionId: string, action: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for action result: ${action.type}`));
      }, 30000);

      this.messageHandlers.set(`action.result.${sessionId}`, (result: any) => {
        clearTimeout(timeout);
        if (result.success === false) {
          reject(new Error(result.error || "Action failed"));
        } else {
          resolve(result);
        }
      });

      this.send({
        sessionId,
        type: "action",
        payload: action,
      });
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.send({
      sessionId,
      type: "session.close",
      payload: {},
    });
  }

  send(message: ExtensionMessage): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(message));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
