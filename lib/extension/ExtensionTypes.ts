/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-nocheck
/**
 * Type definitions for Chrome Extension communication protocol
 */

// Action types that can be sent to the extension
export type ExtensionActionType =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "evaluate"
  | "scroll"
  | "move"
  | "drag"
  | "keypress"
  | "double_click"
  | "right_click"
  | "wait";

// Base action structure
export interface ExtensionAction {
  type: ExtensionActionType;
  [key: string]: unknown;
}

// Specific action interfaces
export interface NavigateAction extends ExtensionAction {
  type: "navigate";
  url: string;
}

export interface ClickAction extends ExtensionAction {
  type: "click";
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
}

export interface TypeAction extends ExtensionAction {
  type: "type";
  text: string;
}

export interface ScreenshotAction extends ExtensionAction {
  type: "screenshot";
}

export interface EvaluateAction extends ExtensionAction {
  type: "evaluate";
  script: string;
}

export interface ScrollAction extends ExtensionAction {
  type: "scroll";
  x: number;
  y: number;
  scrollX?: number;
  scrollY?: number;
}

export interface KeypressAction extends ExtensionAction {
  type: "keypress";
  key: string;
  keys?: string[];
}

// Union of all specific actions
export type SpecificExtensionAction =
  | NavigateAction
  | ClickAction
  | TypeAction
  | ScreenshotAction
  | EvaluateAction
  | ScrollAction
  | KeypressAction;

// Message types
export type ExtensionMessageType =
  | "extension.connect"
  | "session.create"
  | "session.ready"
  | "session.close"
  | "session.closed"
  | "action"
  | "action.result"
  | "screenshot.result"
  | "error"
  | "pong";

// Base message structure
export interface ExtensionMessage {
  type: ExtensionMessageType;
  sessionId?: string;
  payload?: unknown;
  connectionId?: string;
}

// Specific message interfaces
export interface SessionCreateMessage extends ExtensionMessage {
  type: "session.create";
  sessionId: string;
  payload: {
    url?: string;
  };
}

export interface SessionReadyMessage extends ExtensionMessage {
  type: "session.ready";
  sessionId: string;
  payload: {
    tabId: number;
  };
}

export interface ActionMessage extends ExtensionMessage {
  type: "action";
  sessionId: string;
  payload: SpecificExtensionAction;
}

export interface ActionResultMessage extends ExtensionMessage {
  type: "action.result";
  sessionId: string;
  payload: {
    success: boolean;
    result?: unknown;
    error?: string;
    screenshot?: string;
  };
}

export interface ScreenshotResultMessage extends ExtensionMessage {
  type: "screenshot.result";
  sessionId: string;
  payload: {
    screenshot: string;
  };
}

export interface ErrorMessage extends ExtensionMessage {
  type: "error";
  sessionId?: string;
  payload: {
    error: string;
  };
}

// WebSocket message handler type
export type MessageHandler<T = unknown> = (data: T) => void;

// CDP Session interface
export interface CDPSession {
  send: (method: string, params: Record<string, unknown>) => Promise<void>;
}

// Mock element handle interface
export interface MockElementHandle {
  boundingBox: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  click: () => Promise<void>;
  type: (text: string) => Promise<void>;
  evaluate: (
    fn: (element: Element, ...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
}
