import { AgentAction, AgentExecuteOptions, AgentResult } from "@/types/agent";
import { LogLine } from "@/types/log";
import { ActResult } from "@/types/stagehand";
import {
  OperatorResponse,
  operatorResponseSchema,
  operatorSummarySchema,
} from "@/types/operator";
import { LLMClient } from "../llm/LLMClient";
import { buildOperatorSystemPrompt } from "../prompt";
import { StagehandPage } from "../StagehandPage";
import { ObserveResult } from "@/types/stagehand";
import { StagehandError } from "@/types/stagehandErrors";
import { CoreMessage, LanguageModelV1 } from "ai";
import { LLMProvider } from "../llm/LLMProvider";
import { getAISDKLanguageModel } from "../llm/LLMProvider";

export class StagehandOperatorHandler {
  private stagehandPage: StagehandPage;
  private logger: (message: LogLine) => void;
  private llmClient: LLMClient;
  private llmProvider: LLMProvider;
  private messages: CoreMessage[];
  private model: LanguageModelV1 | LLMClient;
  private modelName: string;
  constructor(
    stagehandPage: StagehandPage,
    logger: (message: LogLine) => void,
    llmClient: LLMClient,
    llmProvider: LLMProvider,
    modelName: string,
  ) {
    this.stagehandPage = stagehandPage;
    this.logger = logger;
    this.llmClient = llmClient;
    this.llmProvider = llmProvider;
    this.modelName = modelName;
    console.log("modelName", this.modelName);
    const firstSlashIndex = this.modelName.indexOf("/");
    const subProvider = this.modelName.substring(0, firstSlashIndex);
    const subModelName = this.modelName.substring(firstSlashIndex + 1);

    const languageModel = getAISDKLanguageModel(
      subProvider,
      subModelName,
      this.llmClient.clientOptions?.apiKey,
    );
    this.model = languageModel;
  }

  public async execute(
    instructionOrOptions: string | AgentExecuteOptions,
  ): Promise<AgentResult> {
    const options =
      typeof instructionOrOptions === "string"
        ? { instruction: instructionOrOptions }
        : instructionOrOptions;

    this.messages = [buildOperatorSystemPrompt(options.instruction)];
    let completed = false;
    let currentStep = 0;
    const maxSteps = options.maxSteps || 10;
    const actions: AgentAction[] = [];

    while (!completed && currentStep < maxSteps) {
      const url = this.stagehandPage.page.url();

      if (!url || url === "about:blank") {
        this.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "No page is currently loaded. The first step should be a 'goto' action to navigate to a URL.",
            },
          ],
        });
      } else {
        const screenshot = await this.stagehandPage.page.screenshot({
          type: "png",
          fullPage: false,
        });

        const base64Image = screenshot.toString("base64");

        let messageText = `Here is a screenshot of the current page (URL: ${url}):`;

        messageText = `Previous actions were: ${actions
          .map((action) => {
            let result: string = "";
            if (action.type === "act") {
              // const args = action.playwrightArguments as ObserveResult;
              const args = action.parameters;
              result = `Performed action ${args}`;
            } else if (action.type === "extract") {
              result = `Extracted data: ${action.extractionResult}`;
            }
            return `[${action.type}] ${action.reasoning}. Result: ${result}`;
          })
          .join("\n")}\n\n${messageText}`;

        this.messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: messageText,
            },
            {
              type: "image",
              image: `data:image/png;base64,${base64Image}`,
            },
          ],
        });
      }

      const result = await this.getNextStep(currentStep);

      let extractionResult: unknown | undefined;
      if (result.method === "extract") {
        extractionResult = await this.stagehandPage.extract(result.parameters);
      }

      const res = await this.executeAction(result, extractionResult);
      if (res && typeof res === "object" && "success" in res) {
        actions.push({
          type: result.method,
          reasoning: result.reasoning,
          taskCompleted: res.success,
          parameters: JSON.stringify(res),
          extractionResult: JSON.stringify(extractionResult),
        });
      } else {
        actions.push({
          type: result.method,
          reasoning: result.reasoning,
          taskCompleted: result.taskComplete,
          parameters: JSON.stringify(result.parameters),
          extractionResult: JSON.stringify(extractionResult),
        });
      }

      currentStep++;
    }

    return {
      success: true,
      message: await this.getSummary(options.instruction),
      actions,
      completed: actions[actions.length - 1].taskCompleted as boolean,
    };
  }

  private async getNextStep(currentStep: number): Promise<OperatorResponse> {
    this.logger({
      category: "agent",
      message: `step ${currentStep}`,
      level: 1,
    });
    const response = await this.llmClient.generateObject({
      messages: this.messages,
      schema: operatorResponseSchema,
      model: this.model as LanguageModelV1,
    });
    console.log("response", response);
    return response.object as OperatorResponse;
  }

  private async getSummary(goal: string): Promise<string> {
    this.messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Now use the steps taken to answer the original instruction of ${goal}.`,
        },
      ],
    });
    const response = await this.llmClient.generateObject({
      messages: this.messages,
      schema: operatorSummarySchema,
      model: this.model as LanguageModelV1,
    });
    const answer = response.object.answer;
    if (!answer) {
      throw new StagehandError("Error in OperatorHandler: No answer provided.");
    }
    return answer;
  }

  private async executeAction(
    action: OperatorResponse,
    extractionResult?: unknown,
  ): Promise<unknown> {
    const { method, parameters } = action;
    const page = this.stagehandPage.page;

    switch (method) {
      case "act":
        return await page.act(action.parameters);
      case "extract":
        if (!extractionResult) {
          throw new StagehandError(
            "Error in OperatorHandler: Cannot complete extraction. No extractionResult provided.",
          );
        }
        return extractionResult;
      case "goto":
        await page.goto(parameters, { waitUntil: "load" });
        break;
      case "wait":
        await page.waitForTimeout(parseInt(parameters));
        break;
      case "navback":
        await page.goBack();
        break;
      case "refresh":
        await page.reload();
        break;
      default:
        throw new StagehandError(
          `Error in OperatorHandler: Cannot execute unknown action: ${method}`,
        );
    }
    await this.stagehandPage._waitForSettledDom();
  }
}
