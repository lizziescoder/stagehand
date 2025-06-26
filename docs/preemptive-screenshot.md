# Preemptive Screenshot Feature for Anthropic CUA

## Overview

The preemptive screenshot feature is an optimization for the Anthropic Computer Use Agent (CUA) that automatically captures and includes a screenshot in the initial API request. This eliminates the need for the agent to request a screenshot as its first action, reducing latency by removing one round trip to the API.

## How It Works

### Before (2 API calls):
1. User sends instruction → API call #1
2. Agent responds asking for screenshot → Response #1  
3. Screenshot is taken and sent → API call #2
4. Agent performs actual action → Response #2

### After (1 API call):
1. User sends instruction + screenshot → API call #1
2. Agent performs actual action → Response #1

## Implementation Details

The feature is implemented across several components:

1. **AgentHandler** (`agentHandler.ts`): Captures the initial screenshot before calling the agent
2. **StagehandAgent** (`StagehandAgent.ts`): Passes the screenshot through to the client
3. **AnthropicCUAClient** (`AnthropicCUAClient.ts`): Includes the screenshot in the initial message
4. **OpenAICUAClient** (`OpenAICUAClient.ts`): Also updated for interface consistency

## Usage

The feature is enabled by default when using the Anthropic CUA. No code changes are required:

```typescript
const agent = stagehand.agent({
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
});

// The initial screenshot is automatically captured and sent
const result = await agent.execute({
  instruction: "Click the submit button",
  // autoScreenshot: true (default)
});
```

To disable the preemptive screenshot:

```typescript
const result = await agent.execute({
  instruction: "Click the submit button",
  autoScreenshot: false
});
```

## Benefits

1. **Reduced Latency**: Eliminates one round trip to the API (typically 2-3 seconds)
2. **Fewer API Calls**: Reduces token usage and API costs
3. **Better UX**: Actions execute faster, making the agent feel more responsive
4. **Backward Compatible**: Works with existing code without changes

## Error Handling

If screenshot capture fails:
- A warning is logged
- The agent continues without the initial screenshot
- The agent will request a screenshot as usual (fallback to original behavior)

## Performance Impact

- **Time Saved**: ~2-3 seconds per agent execution
- **Token Savings**: Eliminates one request/response pair
- **Memory**: Base64 screenshots are passed in memory (typically 100-500KB) 