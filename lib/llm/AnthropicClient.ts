import Anthropic, { ClientOptions } from "@anthropic-ai/sdk";
import {
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LogLine } from "../../types/log";
import { AnthropicJsonSchemaObject, AvailableModel } from "../../types/model";
import { LLMCache } from "../cache/LLMCache";
import {
  CreateChatCompletionOptions,
  LLMClient,
  LLMResponse,
} from "./LLMClient";
import { CreateChatCompletionResponseError } from "@/types/stagehandErrors";

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

export class AnthropicClient extends LLMClient {
  public type = "anthropic" as const;
  private client: Anthropic;
  private cache: LLMCache | undefined;
  private enableCaching: boolean;
  public clientOptions: ClientOptions;

  constructor({
    enableCaching = false,
    cache,
    modelName,
    clientOptions,
    userProvidedInstructions,
  }: {
    logger: (message: LogLine) => void;
    enableCaching?: boolean;
    cache?: LLMCache;
    modelName: AvailableModel;
    clientOptions?: ClientOptions;
    userProvidedInstructions?: string;
  }) {
    super(modelName);
    this.client = new Anthropic(clientOptions);
    this.cache = cache;
    this.enableCaching = enableCaching;
    this.modelName = modelName;
    this.clientOptions = clientOptions;
    this.userProvidedInstructions = userProvidedInstructions;
  }

  async createChatCompletion<T = LLMResponse>({
    options,
    retries,
    logger,
  }: CreateChatCompletionOptions): Promise<T> {
    const optionsWithoutImage = { ...options };
    delete optionsWithoutImage.image;

    logger({
      category: "anthropic",
      message: "creating chat completion",
      level: 2,
      auxiliary: {
        options: {
          value: JSON.stringify(optionsWithoutImage),
          type: "object",
        },
      },
    });

    // Try to get cached response
    const cacheOptions = {
      model: this.modelName,
      messages: options.messages,
      temperature: options.temperature,
      image: options.image,
      response_model: options.response_model,
      tools: options.tools,
      retries: retries,
    };

    if (this.enableCaching) {
      const cachedResponse = await this.cache.get<T>(
        cacheOptions,
        options.requestId,
      );
      if (cachedResponse) {
        logger({
          category: "llm_cache",
          message: "LLM cache hit - returning cached response",
          level: 1,
          auxiliary: {
            cachedResponse: {
              value: JSON.stringify(cachedResponse),
              type: "object",
            },
            requestId: {
              value: options.requestId,
              type: "string",
            },
            cacheOptions: {
              value: JSON.stringify(cacheOptions),
              type: "object",
            },
          },
        });
        return cachedResponse as T;
      } else {
        logger({
          category: "llm_cache",
          message: "LLM cache miss - no cached response found",
          level: 1,
          auxiliary: {
            cacheOptions: {
              value: JSON.stringify(cacheOptions),
              type: "object",
            },
            requestId: {
              value: options.requestId,
              type: "string",
            },
          },
        });
      }
    }

    const systemMessage = options.messages.find((msg) => {
      if (msg.role === "system") {
        if (typeof msg.content === "string") {
          return true;
        } else if (Array.isArray(msg.content)) {
          return msg.content.every((content) => content.type !== "image_url");
        }
      }
      return false;
    });

    const userMessages = options.messages.filter(
      (msg) => msg.role !== "system",
    );

    const formattedMessages: MessageParam[] = userMessages.map((msg) => {
      if (typeof msg.content === "string") {
        return {
          role: msg.role as "user" | "assistant", // ensure its not checking for system types
          content: msg.content,
        };
      } else {
        return {
          role: msg.role as "user" | "assistant",
          content: msg.content.map((content) => {
            if ("image_url" in content) {
              const formattedContent: ImageBlockParam = {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: content.image_url.url,
                },
              };

              return formattedContent;
            } else {
              return { type: "text", text: content.text };
            }
          }),
        };
      }
    });

    if (options.image) {
      const screenshotMessage: MessageParam = {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: options.image.buffer.toString("base64"),
            },
          },
        ],
      };
      if (
        options.image.description &&
        Array.isArray(screenshotMessage.content)
      ) {
        screenshotMessage.content.push({
          type: "text",
          text: options.image.description,
        });
      }

      formattedMessages.push(screenshotMessage);
    }

    let anthropicTools: Tool[] = options.tools?.map((tool) => {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: "object",
          properties: tool.parameters.properties,
          required: tool.parameters.required,
        },
      };
    });

    let toolDefinition: Tool | undefined;
    if (options.response_model) {
      const jsonSchema = zodToJsonSchema(options.response_model.schema);
      const { properties: schemaProperties, required: schemaRequired } =
        extractSchemaProperties(jsonSchema);

      toolDefinition = {
        name: "print_extracted_data",
        description: "Prints the extracted data based on the provided schema.",
        input_schema: {
          type: "object",
          properties: schemaProperties,
          required: schemaRequired,
        },
      };
    }

    if (toolDefinition) {
      anthropicTools = anthropicTools ?? [];
      anthropicTools.push(toolDefinition);
    }

    // Retry logic for API calls
    const maxRetries = 8;
    let lastError: unknown = null;
    let delay = 1000; // Initial delay of 1 second

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.modelName,
          max_tokens: options.maxTokens || 8192,
          messages: formattedMessages,
          tools: anthropicTools,
          system: systemMessage
            ? (systemMessage.content as string | TextBlockParam[]) // we can cast because we already filtered out image content
            : undefined,
          temperature: options.temperature,
        });

        logger({
          category: "anthropic",
          message: "response",
          level: 2,
          auxiliary: {
            response: {
              value: JSON.stringify(response),
              type: "object",
            },
            requestId: {
              value: options.requestId,
              type: "string",
            },
          },
        });

        // We'll compute usage data from the response
        const usageData = {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens:
            response.usage.input_tokens + response.usage.output_tokens,
        };

        const transformedResponse: LLMResponse = {
          id: response.id,
          object: "chat.completion",
          created: Date.now(),
          model: response.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  response.content.find((c) => c.type === "text")?.text || null,
                tool_calls: response.content
                  .filter((c) => c.type === "tool_use")
                  .map((toolUse) => ({
                    id: toolUse.id,
                    type: "function",
                    function: {
                      name: toolUse.name,
                      arguments: JSON.stringify(toolUse.input),
                    },
                  })),
              },
              finish_reason: response.stop_reason,
            },
          ],
          usage: usageData,
        };

        logger({
          category: "anthropic",
          message: "transformed response",
          level: 2,
          auxiliary: {
            transformedResponse: {
              value: JSON.stringify(transformedResponse),
              type: "object",
            },
            requestId: {
              value: options.requestId,
              type: "string",
            },
          },
        });

        if (options.response_model) {
          const toolUse = response.content.find((c) => c.type === "tool_use");
          if (toolUse && "input" in toolUse) {
            const result = toolUse.input;

            const finalParsedResponse = {
              data: result,
              usage: usageData,
            } as unknown as T;

            if (this.enableCaching) {
              this.cache.set(
                cacheOptions,
                finalParsedResponse,
                options.requestId,
              );
            }

            return finalParsedResponse;
          } else {
            if (!retries || retries < 5) {
              return this.createChatCompletion({
                options,
                logger,
                retries: (retries ?? 0) + 1,
              });
            }
            logger({
              category: "anthropic",
              message: "error creating chat completion",
              level: 0,
              auxiliary: {
                requestId: {
                  value: options.requestId,
                  type: "string",
                },
              },
            });
            throw new CreateChatCompletionResponseError(
              "No tool use with input in response",
            );
          }
        }

        if (this.enableCaching) {
          this.cache.set(cacheOptions, transformedResponse, options.requestId);
          logger({
            category: "anthropic",
            message: "cached response",
            level: 1,
            auxiliary: {
              requestId: {
                value: options.requestId,
                type: "string",
              },
              transformedResponse: {
                value: JSON.stringify(transformedResponse),
                type: "object",
              },
              cacheOptions: {
                value: JSON.stringify(cacheOptions),
                type: "object",
              },
            },
          });
        }

        // if the function was called with a response model, it would have returned earlier
        // so we can safely cast here to T, which defaults to AnthropicTransformedResponse
        return transformedResponse as T;
      } catch (error) {
        lastError = error;

        // Check if it's a rate limit error
        const isRateLimit = isRateLimitError(error);

        if (isRateLimit) {
          // Extract retry-after header if available
          const retryAfter = getRetryAfter(error);

          if (retryAfter) {
            delay = retryAfter * 1000;
            logger({
              category: "anthropic",
              message: `Rate limit hit, retry-after: ${retryAfter}s`,
              level: 1,
              auxiliary: {
                attempt: { value: attempt.toString(), type: "string" },
                nextDelayMs: { value: delay.toString(), type: "string" },
                requestId: { value: options.requestId, type: "string" },
              },
            });
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
            logger({
              category: "anthropic",
              message:
                "Rate limit hit, using exponential backoff with longer delays",
              level: 1,
              auxiliary: {
                attempt: { value: attempt.toString(), type: "string" },
                nextDelayMs: { value: delay.toString(), type: "string" },
                requestId: { value: options.requestId, type: "string" },
              },
            });
          }
        } else {
          // For non-rate limit errors, use standard backoff but only retry 3 times
          if (attempt >= 3) {
            throw error;
          }
          delay = Math.min(delay * 2, 10000); // Max 10s for non-rate limits

          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger({
            category: "anthropic",
            message: `API error: ${errorMessage}`,
            level: 0,
            auxiliary: {
              attempt: { value: attempt.toString(), type: "string" },
              error: { value: JSON.stringify(error), type: "object" },
              requestId: { value: options.requestId, type: "string" },
            },
          });
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // If we get here, we've exhausted all retries
    throw lastError || new Error("Failed to complete Anthropic API request");
  }
}

const extractSchemaProperties = (jsonSchema: AnthropicJsonSchemaObject) => {
  const schemaRoot = jsonSchema.definitions?.MySchema || jsonSchema;

  return {
    properties: schemaRoot.properties,
    required: schemaRoot.required,
  };
};
