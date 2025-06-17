import { LogLine } from "@/types/log";
import { AgentClient } from "./AgentClient";
import { AgentType } from "@/types/agent";
import { OpenAICUAClient } from "./OpenAICUAClient";
import { AnthropicCUAClient } from "./AnthropicCUAClient";
import {
  UnsupportedModelError,
  UnsupportedModelProviderError,
} from "@/types/stagehandErrors";

// Map model names to their provider types
const modelToAgentProviderMap: Record<string, AgentType> = {
  "computer-use-preview": "openai",
  "claude-3-5-sonnet-20240620": "anthropic",
  "claude-3-7-sonnet-20250219": "anthropic",
  "claude-sonnet-4-20250514": "anthropic", // Add support for claude-sonnet-4
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
    console.log(
      `[STAGEHAND DEBUG] AgentProvider.getClient called with model: ${modelName}`,
    );
    console.log(
      `[STAGEHAND DEBUG] Available models:`,
      Object.keys(modelToAgentProviderMap),
    );

    const type = AgentProvider.getAgentProvider(modelName);
    this.logger({
      category: "agent",
      message: `Getting agent client for type: ${type}, model: ${modelName}`,
      level: 2,
    });

    try {
      switch (type) {
        case "openai":
          console.log(
            `[STAGEHAND DEBUG] Creating OpenAI client for model: ${modelName}`,
          );
          return new OpenAICUAClient(
            type,
            modelName,
            userProvidedInstructions,
            clientOptions,
          );
        case "anthropic":
          console.log(
            `[STAGEHAND DEBUG] Creating Anthropic client for model: ${modelName}`,
          );
          return new AnthropicCUAClient(
            type,
            modelName,
            userProvidedInstructions,
            clientOptions,
          );
        default:
          throw new UnsupportedModelProviderError(
            ["openai", "anthropic"],
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
      console.log(
        `[STAGEHAND DEBUG] Model ${modelName} mapped to provider: ${provider}`,
      );
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
