import { AgentAction, AgentExecuteOptions, AgentResult } from "@/types/agent";
import { LogLine } from "@/types/log";
// import { ActResult } from "@/types/stagehand";
import {
  OperatorResponse,
  operatorResponseSchema,
  operatorSummarySchema,
} from "@/types/operator";
import { LLMClient } from "../llm/LLMClient";
import { buildOperatorSystemPrompt, PLANNER_PROMPT } from "../prompt";
import { StagehandPage } from "../StagehandPage";
// import { ObserveResult } from "@/types/stagehand";
import { StagehandError } from "@/types/stagehandErrors";
import { CoreMessage, LanguageModelV1 } from "ai";
import { LLMProvider } from "../llm/LLMProvider";
import { getAISDKLanguageModel } from "../llm/LLMProvider";
import { google } from "@ai-sdk/google";
import { z } from "zod";


const PlannerLLM = google("gemini-2.5-pro-exp-03-25");

// Define the subtask interface
export interface Subtask {
  id: string;
  description: string;
  goal: string;
  dependencies?: string[]; // IDs of subtasks that must be completed before this one
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "FAILED";
}

// Define the plan interface
export interface TaskPlan {
  summary: string;
  subtasks: Subtask[];
}


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

  public async plan(goal: string): Promise<TaskPlan> {
      // Generate a plan using the LLM
      const planResult = await this.llmClient.generateObject({
        model: PlannerLLM,
        schema: z.object({
          summary: z.string().describe("A summary of the overall task plan"),
          subtasks: z.array(
            z.object({
              description: z.string().describe("A clear description of what this subtask should accomplish"),
              goal: z.string().describe("The specific goal this subtask aims to achieve"),
              dependencies: z.array(z.number()).optional()
                .describe("Array of subtask indices (0-based) that must be completed before this subtask can begin")
            })
          ).min(1).describe("An array of subtasks to accomplish the overall goal")
        }),
        messages: [
          {
            role: "system",
            content: PLANNER_PROMPT
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `I need a plan for accomplishing this task: "${goal}"`
              }
            ]
          }
        ]
      });
      const subtasks = planResult.object.subtasks.map((subtask, index) => ({
        id: `subtask-${index + 1}`,
        description: subtask.description,
        goal: subtask.goal,
        dependencies: subtask.dependencies?.map(depIndex => `subtask-${depIndex + 1}`),
        status: "PENDING" as const
      }));
      
      const plan = {
        summary: planResult.object.summary,
        subtasks
      };
      
      // Store the plan in narrative memory
      const title = `Task Plan: ${goal.substring(0, 100)}${goal.length > 100 ? '...' : ''}`;
      const text = `
  Task: ${goal}
  
  Plan Summary: ${plan.summary}
  
  Subtasks:
  ${plan.subtasks.map((subtask, i) => 
    `${i+1}. ${subtask.goal}
       ${subtask.description}
       Dependencies: ${subtask.dependencies?.length ? subtask.dependencies.join(', ') : 'None'}
    `).join('\n')}
      `;
      return plan;
  }


  public async execute(
    instructionOrOptions: string | AgentExecuteOptions,
  ): Promise<AgentResult> {
    const options =
      typeof instructionOrOptions === "string"
        ? { instruction: instructionOrOptions }
        : instructionOrOptions;

    const plan = await this.plan(options.instruction);
    console.log("plan\n", plan);

    this.messages = [buildOperatorSystemPrompt(options.instruction)];
    const completed = false;
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
