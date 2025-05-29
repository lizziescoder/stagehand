import { EvalFunction } from "@/types/evals";

export const login: EvalFunction = async ({
  debugUrl,
  sessionUrl,
  stagehand,
  logger,
}) => {
  await stagehand.page.goto(
    "https://browserbase.github.io/stagehand-eval-sites/sites/login/",
  );

  await stagehand.page.act({
    action: "type %nunya% into the username field",
    variables: {
      nunya: "business",
    },
  });

  // click the dropdown element to expand it
  const xpath = "xpath=/html/body/main/form/div[1]/input";
  const actualValue = await stagehand.page.locator(xpath).inputValue();

  const expectedValue = "business";
  await stagehand.close();

  // pass if the value matches expected
  return {
    _success: actualValue === expectedValue,
    expectedValue,
    actualValue,
    debugUrl,
    sessionUrl,
    logs: logger.getLogs(),
  };
};
