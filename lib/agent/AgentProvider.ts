import { LogLine } from "@/types/log";
import { AgentClient } from "./AgentClient";
import { AgentType } from "@/types/agent";
import { OpenAICUAClient } from "./OpenAICUAClient";
import { AnthropicCUAClient } from "./AnthropicCUAClient";
import { LumeCUAClient } from "./LumeCUAClient";
import {
  UnsupportedModelError,
  UnsupportedModelProviderError,
} from "@/types/stagehandErrors";

// Map model names to their provider types
const modelToAgentProviderMap: Record<string, AgentType> = {
  "computer-use-preview": "openai",
  "computer-use-preview-2025-03-11": "openai",
  "claude-3-5-sonnet-20240620": "anthropic",
  "claude-3-7-sonnet-20250219": "anthropic",
  "claude-3-7-sonnet-latest": "anthropic",
  "claude-sonnet-4-20250514": "anthropic", // Add support for claude-sonnet-4
  // Lume models - these use the same Anthropic models but with LumeComputer
  "lume-claude-3-5-sonnet-20240620": "lume",
  "lume-claude-3-7-sonnet-20250219": "lume",
  "lume-claude-3-7-sonnet-latest": "lume",
  "lume-claude-sonnet-4-20250514": "lume",
};

/**
 * Provider for agent clients
 * This class is responsible for creating the appropriate agent client
 * based on the provider type
 */
export class AgentProvider {
  private logger: (message: LogLine) => void;

  /**
   * Create a new agent provider
   */
  constructor(logger: (message: LogLine) => void) {
    this.logger = logger;
  }

  getClient(
    modelName: string,
    clientOptions?: Record<string, unknown>,
    userProvidedInstructions?: string,
  ): AgentClient {
    // Add debugging log for incoming model

    const type = AgentProvider.getAgentProvider(modelName);
    this.logger({
      category: "agent",
      message: `Getting agent client for type: ${type}, model: ${modelName}`,
      level: 2,
    });

    try {
      switch (type) {
        case "openai":
          return new OpenAICUAClient(
            type,
            modelName,
            userProvidedInstructions,
            clientOptions,
          );
        case "anthropic":
          return new AnthropicCUAClient(
            type,
            modelName,
            userProvidedInstructions,
            clientOptions,
          );
        case "lume": {
          // For lume, extract the actual model name (remove "lume-" prefix)
          const actualModelName = modelName.startsWith("lume-")
            ? modelName.substring(5)
            : modelName;
          return new LumeCUAClient(
            type,
            actualModelName,
            userProvidedInstructions,
            clientOptions,
          );
        }
        default:
          throw new UnsupportedModelProviderError(
            ["openai", "anthropic", "lume"],
            "Computer Use Agent",
          );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger({
        category: "agent",
        message: `Error creating agent client: ${errorMessage}`,
        level: 0,
      });
      console.error(`[STAGEHAND DEBUG] Error creating agent client:`, error);
      throw error;
    }
  }

  static getAgentProvider(modelName: string): AgentType {
    console.log(
      `[STAGEHAND DEBUG] getAgentProvider called with model: ${modelName}`,
    );

    // First check the exact model name in the map
    if (modelName in modelToAgentProviderMap) {
      const provider = modelToAgentProviderMap[modelName];

      return provider;
    }

    console.error(
      `[STAGEHAND DEBUG] Model ${modelName} not found in map. Available models:`,
      Object.keys(modelToAgentProviderMap),
    );
    throw new UnsupportedModelError(
      Object.keys(modelToAgentProviderMap),
      "Computer Use Agent",
    );
  }
}
