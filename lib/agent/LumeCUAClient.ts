import { AnthropicCUAClient } from "./AnthropicCUAClient";
import { AgentAction, AgentType } from "@/types/agent";
import {
  StagehandError,
  AgentScreenshotProviderError,
} from "@/types/stagehandErrors";

// Interface for LumeComputer to avoid using 'any'
interface LumeComputerInterface {
  screenshot(): Promise<Buffer>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  wait(ms: number): Promise<void>;
  scroll(x: number, y: number): Promise<void>;
  navigate?(url: string): Promise<void>;
}

/**
 * Client for Lume VM automation using Anthropic's Computer Use API
 * This extends AnthropicCUAClient to work with LumeComputer instead of browser pages
 */
export class LumeCUAClient extends AnthropicCUAClient {
  private lumeComputer?: LumeComputerInterface;
  private lumeCurrentUrl?: string; // Track URL for refresh actions

  constructor(
    type: AgentType,
    modelName: string,
    userProvidedInstructions?: string,
    clientOptions?: Record<string, unknown>,
  ) {
    // Call parent with Anthropic type since we're using the same API
    super("anthropic", modelName, userProvidedInstructions, clientOptions);
    // Override the type to be lume for identification
    this.type = type;
  }

  /**
   * Set the LumeComputer instance for this client
   * This should be called by LumeService after initialization
   */
  setLumeComputer(computer: LumeComputerInterface): void {
    this.lumeComputer = computer;

    // Set up the screenshot provider to use LumeComputer
    this.setScreenshotProvider(async () => {
      if (!this.lumeComputer) {
        throw new AgentScreenshotProviderError(
          "LumeComputer not set. Call setLumeComputer() first.",
        );
      }

      try {
        const buffer = await this.lumeComputer.screenshot();
        return buffer.toString("base64");
      } catch (error) {
        throw new AgentScreenshotProviderError(
          `Failed to capture screenshot: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    // Set up the action handler to use LumeComputer
    this.setActionHandler(async (action: AgentAction) => {
      if (!this.lumeComputer) {
        throw new StagehandError(
          "LumeComputer not set. Call setLumeComputer() first.",
        );
      }

      await this.executeLumeAction(action);
    });

    // Set viewport based on LumeComputer display (default to 1280x720)
    this.setViewport(1280, 720);
  }

  /**
   * Execute an action using LumeComputer
   */
  private async executeLumeAction(action: AgentAction): Promise<void> {
    if (!this.lumeComputer) {
      throw new StagehandError("LumeComputer not initialized");
    }

    switch (action.type) {
      case "click": {
        if (typeof action.x === "number" && typeof action.y === "number") {
          await this.lumeComputer.click(action.x, action.y);
        }
        break;
      }

      case "type": {
        if (action.text && typeof action.text === "string") {
          await this.lumeComputer.type(action.text);
        }
        break;
      }

      case "key": {
        if (action.text && typeof action.text === "string") {
          await this.lumeComputer.key(action.text);
        }
        break;
      }

      case "keypress":
      case "hotkey": {
        if (action.keys && Array.isArray(action.keys)) {
          await this.lumeComputer.hotkey(action.keys);
        }
        break;
      }

      case "wait": {
        const ms =
          typeof action.coordinate === "number" ? action.coordinate : 1000;
        await this.lumeComputer.wait(ms);
        break;
      }

      case "scroll": {
        const scrollX = typeof action.x === "number" ? action.x : 0;
        const scrollY = typeof action.y === "number" ? action.y : 0;
        await this.lumeComputer.scroll(scrollX, scrollY);
        break;
      }

      case "refresh": {
        // Refresh current page if navigate method exists
        if (this.lumeComputer.navigate && this.lumeCurrentUrl) {
          await this.lumeComputer.navigate(this.lumeCurrentUrl);
        }
        break;
      }

      default:
        // Ignore unsupported actions
        break;
    }
  }

  /**
   * Override setCurrentUrl to track URL for refresh actions
   */
  setCurrentUrl(url: string): void {
    super.setCurrentUrl(url);
    this.lumeCurrentUrl = url;
  }
}
