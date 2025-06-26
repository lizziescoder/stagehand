import { AgentExecuteOptions } from "../../types/agent";
import { LogLine } from "../../types/log";

export interface AgentExecutionOptions {
  options: AgentExecuteOptions;
  logger: (message: LogLine) => void;
  retries?: number;
  initialScreenshot?: string; // Base64 encoded screenshot for initial request
}
