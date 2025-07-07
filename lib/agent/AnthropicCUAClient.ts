import Anthropic from "@anthropic-ai/sdk";
import { LogLine } from "@/types/log";
import {
  AgentAction,
  AgentResult,
  AgentType,
  AgentExecutionOptions,
  ToolUseItem,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicToolResult,
  AgentStepNarrative,
} from "@/types/agent";
import { AgentClient } from "./AgentClient";
import { AgentScreenshotProviderError } from "@/types/stagehandErrors";

export type ResponseInputItem = AnthropicMessage | AnthropicToolResult;

// Type for usage with cache metrics
interface UsageWithCache {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: number | undefined;
}

// Type for request params
interface AnthropicRequestParams {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  tools: Array<{
    type: string;
    name: string;
    display_width_px: number;
    display_height_px: number;
    display_number: number;
  }>;
  betas: string[];
  system?: Array<{
    type: string;
    text: string;
    cache_control: { type: string };
  }>;
  thinking?: {
    type: "enabled";
    budget_tokens: number;
  };
}

/**
 * Error type that may contain rate limit information
 */
interface PossibleRateLimitError {
  error?: {
    type?: string;
    error?: { type?: string }; // Nested error structure from SDK
  };
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, string> | { get?: (key: string) => string | null };
  };
  headers?: Record<string, string>;
  message?: unknown;
}

/**
 * Check if an error is a rate limit error from Anthropic
 */
const isRateLimitError = (error: unknown): boolean => {
  const err = error as PossibleRateLimitError;
  // Check for Anthropic's rate_limit_error type (including nested structure)
  if (err?.error?.error?.type === "rate_limit_error") return true;
  if (err?.error?.type === "rate_limit_error") return true;

  // Check HTTP status code
  if (err?.status === 429 || err?.response?.status === 429) return true;

  // Check if the error message contains rate limit info
  if (err?.message && typeof err.message === "string") {
    return (
      err.message.includes("rate_limit_error") || err.message.includes("429")
    );
  }

  return false;
};

/**
 * Extract retry-after header from various error structures
 */
const getRetryAfter = (error: unknown): number | null => {
  const err = error as PossibleRateLimitError;
  const headers = err?.headers;
  const responseHeaders = err?.response?.headers;

  let retryAfter: string | null | undefined = headers?.["retry-after"];

  if (!retryAfter && responseHeaders) {
    if (typeof responseHeaders.get === "function") {
      retryAfter = responseHeaders.get("retry-after");
    } else if (typeof responseHeaders === "object") {
      retryAfter = (responseHeaders as Record<string, string>)["retry-after"];
    }
  }

  return retryAfter ? parseInt(retryAfter) : null;
};

/**
 * Client for Anthropic's Computer Use API
 * This implementation uses the official Anthropic Messages API for Computer Use
 */
export class AnthropicCUAClient extends AgentClient {
  private apiKey: string;
  private baseURL?: string;
  private client: Anthropic;
  public lastMessageId?: string;
  private currentViewport = { width: 1024, height: 768 };
  private currentUrl?: string;
  private screenshotProvider?: () => Promise<string>;
  private actionHandler?: (action: AgentAction) => Promise<void>;
  private thinkingBudget: number | null = null;
  private stepNarratives: AgentStepNarrative[] = [];
  private currentStepIndex: number = 0;
  private hasInitialScreenshot: boolean = false;

  constructor(
    type: AgentType,
    modelName: string,
    userProvidedInstructions?: string,
    clientOptions?: Record<string, unknown>,
  ) {
    super(type, modelName, userProvidedInstructions);

    // Process client options
    this.apiKey =
      (clientOptions?.apiKey as string) || process.env.ANTHROPIC_API_KEY || "";
    this.baseURL = (clientOptions?.baseURL as string) || undefined;

    // Get thinking budget if specified
    if (
      clientOptions?.thinkingBudget &&
      typeof clientOptions.thinkingBudget === "number"
    ) {
      this.thinkingBudget = clientOptions.thinkingBudget;
    }

    // Store client options for reference
    this.clientOptions = {
      apiKey: this.apiKey,
    };

    if (this.baseURL) {
      this.clientOptions.baseUrl = this.baseURL;
    }

    // Initialize the Anthropic client
    this.client = new Anthropic(this.clientOptions);
  }

  setViewport(width: number, height: number): void {
    this.currentViewport = { width, height };
  }

  setCurrentUrl(url: string): void {
    this.currentUrl = url;
  }

  setScreenshotProvider(provider: () => Promise<string>): void {
    this.screenshotProvider = provider;
  }

  setActionHandler(handler: (action: AgentAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  /**
   * Execute a task with the Anthropic CUA
   * This is the main entry point for the agent
   * @implements AgentClient.execute
   */
  async execute(executionOptions: AgentExecutionOptions): Promise<AgentResult> {
    const { options, logger, initialScreenshot } = executionOptions;
    const { instruction } = options;
    const maxSteps = options.maxSteps || 10;

    // Reset narratives for new execution
    this.stepNarratives = [];
    this.currentStepIndex = 0;
    this.hasInitialScreenshot = !!initialScreenshot;

    logger({
      category: "agent",
      message: `Starting agent task: ${instruction}`,
      level: 1,
    });

    let currentStep = 0;
    let completed = false;
    const actions: AgentAction[] = [];
    const messageList: string[] = [];
    let finalMessage = "";

    // Start with the initial instruction and optional screenshot
    let inputItems: ResponseInputItem[] = this.createInitialInputItems(
      instruction,
      initialScreenshot,
    );

    logger({
      category: "agent",
      message: `Starting Anthropic agent execution with instruction: ${instruction}`,
      level: 1,
    });

    logger({
      category: "agent",
      message: `Initial screenshot provided: ${initialScreenshot ? `Yes (${initialScreenshot.length} chars)` : "No"}`,
      level: 1,
    });

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalInferenceTime = 0;

    try {
      // Execute steps until completion or max steps reached
      while (!completed && currentStep < maxSteps) {
        logger({
          category: "agent",
          message: `Executing step ${currentStep + 1}/${maxSteps}`,
          level: 2,
        });

        const result = await this.executeStep(inputItems, logger);
        totalInputTokens += result.usage.input_tokens;
        totalOutputTokens += result.usage.output_tokens;
        totalInferenceTime += result.usage.inference_time_ms;

        // Add actions to the list
        if (result.actions.length > 0) {
          logger({
            category: "agent",
            message: `Step ${currentStep + 1} performed ${result.actions.length} actions`,
            level: 2,
          });
          actions.push(...result.actions);
        }

        // Update completion status
        completed = result.completed;

        // Update the input items for the next step if we're continuing
        if (!completed) {
          inputItems = result.nextInputItems;
        }

        // Record any message for this step
        if (result.message) {
          messageList.push(result.message);
          finalMessage = result.message;
        }

        // Increment step counter
        currentStep++;
      }

      logger({
        category: "agent",
        message: `Anthropic agent execution completed: ${completed}, with ${actions.length} total actions performed`,
        level: 1,
      });

      // Return the final result
      return {
        success: completed,
        actions,
        message: finalMessage,
        completed,
        stepNarratives: this.stepNarratives,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          inference_time_ms: totalInferenceTime,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger({
        category: "agent",
        message: `Error executing agent task: ${errorMessage}`,
        level: 0,
      });

      return {
        success: false,
        actions,
        message: `Failed to execute task: ${errorMessage}`,
        completed: false,
        stepNarratives: this.stepNarratives,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          inference_time_ms: totalInferenceTime,
        },
      };
    }
  }

  async executeStep(
    inputItems: ResponseInputItem[],
    logger: (message: LogLine) => void,
  ): Promise<{
    actions: AgentAction[];
    message: string;
    completed: boolean;
    nextInputItems: ResponseInputItem[];
    usage: {
      input_tokens: number;
      output_tokens: number;
      inference_time_ms: number;
    };
  }> {
    const stepStartTime = Date.now();

    try {
      // Get response from the model
      const result = await this.getAction(inputItems);
      const content = result.content;
      const usage = {
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        inference_time_ms: result.usage.inference_time_ms,
      };

      logger({
        category: "agent",
        message: `Received response with ${content.length} content blocks`,
        level: 2,
      });

      // Extract actions from the content
      const stepActions: AgentAction[] = [];
      const toolUseItems: ToolUseItem[] = [];
      let assistantMessage = "";

      // Process content blocks to find tool use items and text content
      for (const block of content) {
        // Log the block for debugging
        console.log("Processing block:", JSON.stringify(block, null, 2));

        // Enhanced logging for debugging
        logger({
          category: "agent",
          message: `Processing block type: ${block.type}, id: ${block.id || "unknown"}`,
          level: 2,
        });

        if (block.type === "tool_use") {
          // Direct handling of tool_use type
          logger({
            category: "agent",
            message: `Found tool_use block: ${JSON.stringify(block)}`,
            level: 2,
          });

          // Cast to ToolUseItem and add to list
          const toolUseItem = block as ToolUseItem;
          toolUseItems.push(toolUseItem);

          logger({
            category: "agent",
            message: `Added tool_use item: ${toolUseItem.name}, action: ${JSON.stringify(toolUseItem.input)}`,
            level: 2,
          });

          // Convert tool use to action and add to actions list
          const action = this.convertToolUseToAction(toolUseItem);
          if (action) {
            logger({
              category: "agent",
              message: `Created action from tool_use: ${toolUseItem.name}, action: ${action.type}`,
              level: 2,
            });
            stepActions.push(action);
          }
        } else if (block.type === "text") {
          // Safe to cast here since we've verified it's a text block
          const textBlock = block as unknown as AnthropicTextBlock;
          assistantMessage += textBlock.text + " ";

          logger({
            category: "agent",
            message: `Found text block: ${textBlock.text.substring(0, 50)}...`,
            level: 2,
          });
        } else {
          logger({
            category: "agent",
            message: `Found unknown block type: ${block.type}`,
            level: 2,
          });
        }
      }

      // Execute actions if an action handler is provided
      if (this.actionHandler && stepActions.length > 0) {
        for (const action of stepActions) {
          try {
            logger({
              category: "agent",
              message: `Executing action: ${action.type}`,
              level: 1,
            });
            await this.actionHandler(action);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            logger({
              category: "agent",
              message: `Error executing action ${action.type}: ${errorMessage}`,
              level: 0,
            });
          }
        }

        // Store narrative without screenshot
        this.stepNarratives.push({
          stepIndex: this.currentStepIndex++,
          message: assistantMessage.trim(),
          action: stepActions[0],
          timestamp: Date.now(),
          executionTimeMs: Date.now() - stepStartTime,
        });
      }

      // Create the assistant response message with all content blocks
      const assistantResponseMessage: AnthropicMessage = {
        role: "assistant",
        content: content as unknown as AnthropicContentBlock[],
      };

      // Keep track of the conversation history by preserving all previous messages
      // and adding new messages at the end
      const nextInputItems: ResponseInputItem[] = [...inputItems];

      // Add the assistant message with tool_use blocks to the history
      nextInputItems.push(assistantResponseMessage);

      // Generate tool results and add them as a user message
      if (toolUseItems.length > 0) {
        const toolResults = await this.takeAction(toolUseItems, logger);

        if (toolResults.length > 0) {
          // We wrap the tool results in a user message
          const userToolResultsMessage: AnthropicMessage = {
            role: "user",
            content: toolResults as unknown as AnthropicContentBlock[],
          };
          nextInputItems.push(userToolResultsMessage);
        }
      }

      // The step is completed only if there were no tool_use items
      const completed = toolUseItems.length === 0;

      logger({
        category: "agent",
        message: `Step processed ${toolUseItems.length} tool use items, completed: ${completed}`,
        level: 2,
      });

      return {
        actions: stepActions,
        message: assistantMessage.trim(),
        completed,
        nextInputItems,
        usage: usage,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger({
        category: "agent",
        message: `Error executing step: ${errorMessage}`,
        level: 0,
      });

      throw error;
    }
  }

  private createInitialInputItems(
    instruction: string,
    initialScreenshot?: string,
  ): AnthropicMessage[] {
    const messages: AnthropicMessage[] = [];

    // Modify system message to include initial screenshot context
    let systemContent = this.userProvidedInstructions || "";

    if (initialScreenshot) {
      systemContent +=
        "\n\nIMPORTANT: An initial screenshot of the current page has been provided with your first message. You do NOT need to take a screenshot action before proceeding with the task. The screenshot shows the current state of the page.";
    }

    messages.push({
      role: "system",
      content: systemContent,
    });

    // If we have an initial screenshot, include it with the instruction
    if (initialScreenshot) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: instruction,
          },
          {
            type: "text",
            text: "Here is the current screenshot of the page:",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: initialScreenshot.replace(/^data:image\/png;base64,/, ""),
            },
          },
          {
            type: "text",
            text: `Current URL: ${this.currentUrl || "unknown"}`,
          },
        ],
      });
    } else {
      // Fallback to text-only message
      messages.push({
        role: "user",
        content: instruction,
      });
    }

    return messages;
  }

  async getAction(inputItems: ResponseInputItem[]): Promise<{
    content: AnthropicContentBlock[];
    id: string;
    usage: Record<string, number>;
  }> {
    try {
      // For the API request, we use the inputItems directly
      // These should already be properly formatted as a sequence of user/assistant messages
      const messages: AnthropicMessage[] = [];

      for (const item of inputItems) {
        if ("role" in item) {
          // Skip system messages as Anthropic requires system as a top-level parameter
          if (item.role !== "system") {
            messages.push(item);
          }
        }
        // Note: We don't need special handling for tool_result items here anymore
        // as they should already be properly wrapped in user messages
      }

      // Configure thinking capability if available
      const thinking = this.thinkingBudget
        ? { type: "enabled" as const, budget_tokens: this.thinkingBudget }
        : undefined;

      // Create the request parameters

      const requestParams: AnthropicRequestParams = {
        model: this.modelName,
        max_tokens: 4096,
        messages: messages,
        tools: [
          {
            type: "computer_20250124", // Use the latest version for Claude 3.7 Sonnet
            name: "computer",
            display_width_px: this.currentViewport.width,
            display_height_px: this.currentViewport.height,
            display_number: 1,
          },
        ],
        betas: ["computer-use-2025-01-24"],
      };

      // Add system parameter with caching if provided
      if (this.userProvidedInstructions || this.hasInitialScreenshot) {
        // Build system content with initial screenshot context if needed
        let systemContent = this.userProvidedInstructions || "";

        if (this.hasInitialScreenshot) {
          systemContent +=
            "\n\nIMPORTANT: An initial screenshot of the current page has been provided with your first message. You do NOT need to take a screenshot action before proceeding with the task. The screenshot shows the current state of the page.";
          // Clear the flag after first use to avoid adding this message in subsequent calls
          this.hasInitialScreenshot = false;
        }

        // Make system cacheable by structuring it properly for prompt caching
        requestParams.system = [
          {
            type: "text",
            text: systemContent,
            cache_control: { type: "ephemeral" },
          },
        ];
      }

      // Add thinking parameter if available
      if (thinking) {
        requestParams.thinking = thinking;
      }

      // Retry logic for API calls
      const maxRetries = 8;
      let lastError: unknown = null;
      let delay = 1000; // Initial delay of 1 second

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const startTime = Date.now();
          // Create the message using the Anthropic Messages API
          // Prompt caching is now generally available - no special headers needed
          const response = (await this.client.beta.messages.create(
            requestParams as Parameters<
              typeof this.client.beta.messages.create
            >[0],
          )) as Anthropic.Beta.BetaMessage;
          const endTime = Date.now();
          const elapsedMs = endTime - startTime;
          const usage = {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            inference_time_ms: elapsedMs,
          };

          // Log cache metrics if available
          if (response.usage) {
            const usageWithCache = response.usage as UsageWithCache;
            const cacheMetrics = {
              cache_creation_tokens:
                usageWithCache.cache_creation_input_tokens || 0,
              cache_read_tokens: usageWithCache.cache_read_input_tokens || 0,
              regular_input_tokens: response.usage.input_tokens || 0,
              model: this.modelName,
            };

            if (
              cacheMetrics.cache_creation_tokens > 0 ||
              cacheMetrics.cache_read_tokens > 0
            ) {
              console.log("Stagehand agent cache metrics:", cacheMetrics);
            }
          }

          // Store the message ID for future use
          this.lastMessageId = response.id;

          // Return the content and message ID
          return {
            // Cast the response content to our internal type
            content: response.content as unknown as AnthropicContentBlock[],
            id: response.id,
            usage,
          };
        } catch (error) {
          lastError = error;

          // Check if it's a rate limit error
          const isRateLimit = isRateLimitError(error);

          if (isRateLimit) {
            // Extract retry-after header if available
            const retryAfter = getRetryAfter(error);

            if (retryAfter) {
              delay = retryAfter * 1000;
              console.log(
                `[AnthropicCUA] Rate limit hit, retry-after: ${retryAfter}s, attempt: ${attempt}/${maxRetries}`,
              );
            } else {
              // For rate limits without retry-after, use longer delays
              if (attempt === 1) {
                delay = 10000; // 10 seconds initial delay for rate limits
              } else {
                // Exponential backoff with jitter, more aggressive for rate limits
                const baseDelay = Math.min(delay * 2, 120000); // Max 2 minutes
                const jitter = Math.random() * 5000; // 0-5s jitter
                delay = baseDelay + jitter;
              }
              console.log(
                `[AnthropicCUA] Rate limit hit, using exponential backoff with longer delays: ${delay}ms, attempt: ${attempt}/${maxRetries}`,
              );
            }
          } else {
            // For non-rate limit errors, use standard backoff but only retry 3 times
            if (attempt >= 3) {
              console.error("Error getting action from Anthropic:", error);
              throw error;
            }
            delay = Math.min(delay * 2, 10000); // Max 10s for non-rate limits
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[AnthropicCUA] API error (attempt ${attempt}/${maxRetries}):`,
              errorMessage,
            );
          }

          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // If we get here, we've exhausted all retries
      console.error(
        "Error getting action from Anthropic after all retries:",
        lastError,
      );
      throw lastError;
    } catch (error) {
      console.error("Error getting action from Anthropic:", error);
      throw error;
    }
  }

  async takeAction(
    toolUseItems: ToolUseItem[],
    logger: (message: LogLine) => void,
  ): Promise<ResponseInputItem[]> {
    const nextInputItems: ResponseInputItem[] = [];

    logger({
      category: "agent",
      message: `Taking action on ${toolUseItems.length} tool use items`,
      level: 2,
    });

    // Process each tool use item
    for (const item of toolUseItems) {
      try {
        logger({
          category: "agent",
          message: `Processing tool use: ${item.name}, id: ${item.id}, action: ${JSON.stringify(item.input)}`,
          level: 2,
        });

        // TODO: Normalize and migrate to agentHandler

        // For computer tool, capture screenshot and return image
        if (item.name === "computer") {
          // Get action type
          const action = item.input.action as string;
          logger({
            category: "agent",
            message: `Computer action type: ${action}`,
            level: 2,
          });

          // Capture a screenshot for the response
          const screenshot = await this.captureScreenshot();
          logger({
            category: "agent",
            message: `Screenshot captured, length: ${screenshot.length}`,
            level: 2,
          });

          // Create proper image content block for Anthropic
          const imageContent = [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot.replace(/^data:image\/png;base64,/, ""),
              },
            },
          ];

          // Add current URL if available
          if (this.currentUrl) {
            nextInputItems.push({
              type: "tool_result",
              tool_use_id: item.id,
              content: [
                ...imageContent,
                {
                  type: "text",
                  text: `Current URL: ${this.currentUrl}`,
                },
              ],
            });
          } else {
            nextInputItems.push({
              type: "tool_result",
              tool_use_id: item.id,
              content: imageContent,
            });
          }

          logger({
            category: "agent",
            message: `Added computer tool result for tool_use_id: ${item.id}`,
            level: 2,
          });
        } else {
          // For any other tools, return a simple result as a string
          nextInputItems.push({
            type: "tool_result",
            tool_use_id: item.id,
            content: "Tool executed successfully",
          });

          logger({
            category: "agent",
            message: `Added generic tool result for tool ${item.name}, tool_use_id: ${item.id}`,
            level: 2,
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        logger({
          category: "agent",
          message: `Error executing tool use: ${errorMessage}`,
          level: 0,
        });

        try {
          // For computer tool, try to capture a screenshot even on error
          if (item.name === "computer") {
            const screenshot = await this.captureScreenshot();

            nextInputItems.push({
              type: "tool_result",
              tool_use_id: item.id,
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: screenshot.replace(/^data:image\/png;base64,/, ""),
                  },
                },
                {
                  type: "text",
                  text: `Error: ${errorMessage}`,
                },
              ],
            });

            logger({
              category: "agent",
              message: `Added error tool result with screenshot for tool_use_id: ${item.id}`,
              level: 1,
            });
          } else {
            // For other tools, return an error message as a string
            nextInputItems.push({
              type: "tool_result",
              tool_use_id: item.id,
              content: `Error: ${errorMessage}`,
            });

            logger({
              category: "agent",
              message: `Added error tool result for tool_use_id: ${item.id}`,
              level: 1,
            });
          }
        } catch (screenshotError) {
          // If we can't capture a screenshot, just send the error
          logger({
            category: "agent",
            message: `Error capturing screenshot: ${String(screenshotError)}`,
            level: 0,
          });

          nextInputItems.push({
            type: "tool_result",
            tool_use_id: item.id,
            content: `Error: ${errorMessage}`,
          });

          logger({
            category: "agent",
            message: `Added text error tool result for tool_use_id: ${item.id}`,
            level: 1,
          });
        }
      }
    }

    logger({
      category: "agent",
      message: `Prepared ${nextInputItems.length} input items for next request`,
      level: 2,
    });

    return nextInputItems;
  }

  private convertToolUseToAction(item: ToolUseItem): AgentAction | null {
    try {
      const { name, input } = item;

      if (name === "computer") {
        // For computer actions, format according to the action type
        const action = input.action as string;

        if (!action) {
          console.warn("Missing action in tool use item:", item);
          return null;
        }

        // Handle different action types specifically
        if (action === "screenshot") {
          return {
            type: "screenshot",
            ...input,
          };
        } else if (action === "click") {
          return {
            type: "click",
            x: input.x as number,
            y: input.y as number,
            button: (input.button as string) || "left",
            ...input,
          };
        } else if (action === "type") {
          return {
            type: "type",
            text: input.text as string,
            ...input,
          };
        } else if (action === "keypress") {
          return {
            type: "keypress",
            keys: input.keys as string[],
            ...input,
          };
        } else if (action === "double_click" || action === "doubleClick") {
          return {
            type: action,
            x: input.x as number,
            y: input.y as number,
            ...input,
          };
        } else if (action === "scroll") {
          // Convert Anthropic's coordinate, scroll_amount and scroll_direction into scroll_x and scroll_y
          const x =
            (input.x as number) ||
            (input.coordinate ? (input.coordinate as number[])[0] : 0);
          const y =
            (input.y as number) ||
            (input.coordinate ? (input.coordinate as number[])[1] : 0);

          // Calculate scroll_x and scroll_y based on scroll_amount and scroll_direction
          let scroll_x = 0;
          let scroll_y = 0;

          const scrollAmount = (input.scroll_amount as number) || 5;
          const scrollMultiplier = 100; // Pixels per unit of scroll_amount

          if (input.scroll_direction) {
            const direction = input.scroll_direction as string;
            if (direction === "down") {
              scroll_y = scrollAmount * scrollMultiplier;
            } else if (direction === "up") {
              scroll_y = -scrollAmount * scrollMultiplier;
            } else if (direction === "right") {
              scroll_x = scrollAmount * scrollMultiplier;
            } else if (direction === "left") {
              scroll_x = -scrollAmount * scrollMultiplier;
            }
          } else {
            // Use direct scroll_x and scroll_y if provided
            scroll_x = (input.scroll_x as number) || 0;
            scroll_y = (input.scroll_y as number) || 0;
          }

          return {
            type: "scroll",
            x: x,
            y: y,
            scroll_x: scroll_x,
            scroll_y: scroll_y,
            ...input,
          };
        } else if (action === "move") {
          // Handle Anthropic's coordinate format
          const coordinates = input.coordinate as number[] | undefined;
          const x = coordinates ? coordinates[0] : (input.x as number) || 0;
          const y = coordinates ? coordinates[1] : (input.y as number) || 0;

          return {
            type: "move",
            x: x,
            y: y,
            ...input,
          };
        } else if (action === "drag") {
          // Make sure path is properly formatted
          const path =
            (input.path as { x: number; y: number }[]) ||
            (input.coordinate
              ? [
                  {
                    x: (input.start_coordinate as number[])[0],
                    y: (input.start_coordinate as number[])[1],
                  },
                  {
                    x: (input.coordinate as number[])[0],
                    y: (input.coordinate as number[])[1],
                  },
                ]
              : []);

          return {
            type: "drag",
            path: path,
            ...input,
          };
        } else if (action === "wait") {
          return {
            type: "wait",
            ...input,
          };
        } else if (action === "key") {
          const text = input.text as string;
          // Convert common key names to a format our handler can understand
          let mappedKey = text;

          if (
            text === "Return" ||
            text === "return" ||
            text === "Enter" ||
            text === "enter"
          ) {
            mappedKey = "Enter";
          } else if (text === "Tab" || text === "tab") {
            mappedKey = "Tab";
          } else if (
            text === "Escape" ||
            text === "escape" ||
            text === "Esc" ||
            text === "esc"
          ) {
            mappedKey = "Escape";
          } else if (text === "Backspace" || text === "backspace") {
            mappedKey = "Backspace";
          } else if (
            text === "Delete" ||
            text === "delete" ||
            text === "Del" ||
            text === "del"
          ) {
            mappedKey = "Delete";
          } else if (text === "ArrowUp" || text === "Up" || text === "up") {
            mappedKey = "ArrowUp";
          } else if (
            text === "ArrowDown" ||
            text === "Down" ||
            text === "down"
          ) {
            mappedKey = "ArrowDown";
          } else if (
            text === "ArrowLeft" ||
            text === "Left" ||
            text === "left"
          ) {
            mappedKey = "ArrowLeft";
          } else if (
            text === "ArrowRight" ||
            text === "Right" ||
            text === "right"
          ) {
            mappedKey = "ArrowRight";
          }

          return {
            type: "key",
            text: mappedKey,
            ...input,
          };
        } else if (action === "left_click") {
          // Convert left_click to regular click
          const coordinates = input.coordinate as number[] | undefined;
          const x = coordinates ? coordinates[0] : (input.x as number) || 0;
          const y = coordinates ? coordinates[1] : (input.y as number) || 0;

          return {
            type: "click",
            x: x,
            y: y,
            button: "left",
            ...input,
          };
        } else {
          // For other computer actions, use the action type directly
          console.log(`Using default action mapping for ${action}`);
          return {
            type: action,
            ...input,
          };
        }
      } else if (name === "str_replace_editor" || name === "bash") {
        // For editor or bash tools
        return {
          type: name,
          params: input,
        };
      }

      console.warn(`Unknown tool name: ${name}`);
      return null;
    } catch (error) {
      console.error("Error converting tool use to action:", error);
      return null;
    }
  }

  async captureScreenshot(options?: {
    base64Image?: string;
    currentUrl?: string;
  }): Promise<string> {
    // Use provided options if available
    if (options?.base64Image) {
      return `data:image/png;base64,${options.base64Image}`;
    }

    // Use the screenshot provider if available
    if (this.screenshotProvider) {
      try {
        const base64Image = await this.screenshotProvider();
        return `data:image/png;base64,${base64Image}`;
      } catch (error) {
        console.error("Error capturing screenshot:", error);
        throw error;
      }
    }

    throw new AgentScreenshotProviderError(
      "`screenshotProvider` has not been set. " +
        "Please call `setScreenshotProvider()` with a valid function that returns a base64-encoded image",
    );
  }
}
