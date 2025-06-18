export interface AgentExecutionOptions {
  options: AgentExecuteOptions;
  logger: (message: LogLine) => void;
  retries?: number;
  initialScreenshot?: string; // Base64 encoded screenshot for initial request
} 