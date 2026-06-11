import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../helpers/maxTokensHelper.js";

const WEB_SEARCH_TOOL_TYPES = /^web_search/;
const CLAUDE_AGENT_TOOL_NAMES = new Set(["Agent"]);

function isClaudeWebSearchTool(tool) {
  return typeof tool?.type === "string" && WEB_SEARCH_TOOL_TYPES.test(tool.type);
}

function sanitizeClaudeAgentInput(toolName, input) {
  if (!CLAUDE_AGENT_TOOL_NAMES.has(toolName) || !input || typeof input !== "object" || Array.isArray(input)) {
    return input || {};
  }
  if (!("isolation" in input)) return input;
  const { isolation, ...sanitizedInput } = input;
  return sanitizedInput;
}

function sanitizeClaudeAgentSchema(tool) {
  const schema = tool.input_schema || { type: "object", properties: {} };
  if (!CLAUDE_AGENT_TOOL_NAMES.has(tool.name) || !schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("isolation" in properties)) {
    return schema;
  }
  const { isolation, ...sanitizedProperties } = properties;
  const sanitizedSchema = { ...schema, properties: sanitizedProperties };
  if (Array.isArray(schema.required)) {
    sanitizedSchema.required = schema.required.filter(key => key !== "isolation");
  }
  return sanitizedSchema;
}

function convertClaudeTool(tool) {
  if (isClaudeWebSearchTool(tool)) {
    const { input_schema, ...nativeTool } = tool;
    return nativeTool;
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: String(tool.description || ""),
      parameters: sanitizeClaudeAgentSchema(tool),
    }
  };
}

function stripAnthropicBillingHeader(text) {
  if (typeof text !== "string") return "";
  return text.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");
}

// Convert Claude request to OpenAI format
export function claudeToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Max tokens — GPT-5.4+ requires max_completion_tokens instead of max_tokens
  if (body.max_tokens) {
    const isGpt54Plus = /^gpt-5\.[4-9]|^gpt-5\.\d{2,}/.test(model);
    const tokenKey = isGpt54Plus ? "max_completion_tokens" : "max_tokens";
    result[tokenKey] = adjustMaxTokens(body);
  }

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // Map Claude thinking → OpenAI reasoning_effort (symmetric to openai-to-claude.js).
  // Without this, Claude clients targeting OpenAI-format providers (e.g. Vercel AI Gateway,
  // OpenRouter, OpenAI) silently lose reasoning intent.
  if (body.thinking && !result.reasoning_effort) {
    if (body.thinking.type === "enabled") {
      const budget = body.thinking.budget_tokens || 0;
      if (budget <= 0) {
        // No explicit budget → default medium
        result.reasoning_effort = "medium";
      } else if (budget <= 2048) {
        result.reasoning_effort = "low";
      } else if (budget <= 16384) {
        result.reasoning_effort = "medium";
      } else {
        result.reasoning_effort = "high";
      }
    } else if (body.thinking.type === "disabled") {
      result.reasoning_effort = "none";
    }
  }

  // System message
  if (body.system) {
    const systemContent = Array.isArray(body.system)
      ? body.system.map(s => stripAnthropicBillingHeader(s.text || "")).filter(Boolean).join("\n")
      : stripAnthropicBillingHeader(body.system);
    
    if (systemContent) {
      result.messages.push({
        role: "system",
        content: systemContent
      });
    }
  }

  // Convert messages
  if (body.messages && Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      const converted = convertClaudeMessage(msg);
      if (converted) {
        // Handle array of messages (multiple tool results)
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Fix missing tool responses - OpenAI requires every tool_call to have a response
  fixMissingToolResponses(result.messages);

  // Tools — web_search native pass-through, Agent isolation sanitization
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(convertClaudeTool);
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  return result;
}

// Fix missing tool responses - add empty responses for tool_calls without responses
function fixMissingToolResponses(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCallIds = msg.tool_calls.map(tc => tc.id);
      
      // Collect all tool response IDs that IMMEDIATELY follow this assistant message
      const respondedIds = new Set();
      let insertPosition = i + 1;
      for (let j = i + 1; j < messages.length; j++) {
        const nextMsg = messages[j];
        if (nextMsg.role === "tool" && nextMsg.tool_call_id) {
          respondedIds.add(nextMsg.tool_call_id);
          insertPosition = j + 1;
        } else {
          break;
        }
      }
      
      // Find missing responses and insert them
      const missingIds = toolCallIds.filter(id => !respondedIds.has(id));
      
      if (missingIds.length > 0) {
        const missingResponses = missingIds.map(id => ({
          role: "tool",
          tool_call_id: id,
          content: "[No response received]"
        }));
        messages.splice(insertPosition, 0, ...missingResponses);
        i = insertPosition + missingResponses.length - 1;
      }
    }
  }
}

// Convert single Claude message - returns single message or array of messages
function convertClaudeMessage(msg) {
  const role = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";
  
  // Simple string content
  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // Array content
  if (Array.isArray(msg.content)) {
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ type: "text", text: block.text });
          break;

        case "image":
          if (block.source?.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`
              }
            });
          }
          break;

        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(sanitizeClaudeAgentInput(block.name, block.input) || {})
            }
          });
          break;

        case "tool_result":
          let resultContent = "";
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter(c => c.type === "text")
              .map(c => c.text)
              .join("\n") || JSON.stringify(block.content);
          } else if (block.content) {
            resultContent = JSON.stringify(block.content);
          }
          
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: resultContent
          });
          break;
      }
    }

    // If has tool results, return array of tool messages
    if (toolResults.length > 0) {
      if (parts.length > 0) {
        const textContent = parts.length === 1 && parts[0].type === "text" 
          ? parts[0].text 
          : parts;
        return [...toolResults, { role: "user", content: textContent }];
      }
      return toolResults;
    }

    // If has tool calls, return assistant message with tool_calls
    if (toolCalls.length > 0) {
      const result = { role: "assistant" };
      if (parts.length > 0) {
        result.content = parts.length === 1 && parts[0].type === "text" 
          ? parts[0].text 
          : parts;
      }
      result.tool_calls = toolCalls;
      return result;
    }

    // Return content
    if (parts.length > 0) {
      return {
        role,
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts
      };
    }
    
    // Empty content array
    if (msg.content.length === 0) {
      return { role, content: "" };
    }
  }

  return null;
}

// Convert tool choice
function convertToolChoice(choice) {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  
  switch (choice.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "tool": return { type: "function", function: { name: choice.name } };
    default: return "auto";
  }
}

// Register
register(FORMATS.CLAUDE, FORMATS.OPENAI, claudeToOpenAIRequest, null);
