import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../helpers/maxTokensHelper.js";

// Convert Gemini request to OpenAI format
export function geminiToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream
  };

  // Generation config
  if (body.generationConfig) {
    const config = body.generationConfig;
    if (config.maxOutputTokens) {
      const tempBody = { max_tokens: config.maxOutputTokens, tools: body.tools };
      result.max_tokens = adjustMaxTokens(tempBody);
    }
    if (config.temperature !== undefined) {
      result.temperature = config.temperature;
    }
    if (config.topP !== undefined) {
      result.top_p = config.topP;
    }
  }

  // System instruction
  if (body.systemInstruction) {
    const systemText = extractGeminiText(body.systemInstruction);
    if (systemText) {
      result.messages.push({
        role: "system",
        content: systemText
      });
    }
  }

  // Convert contents to messages
  if (body.contents && Array.isArray(body.contents)) {
    for (const content of body.contents) {
      const converted = convertGeminiContent(content);
      if (converted) {
        result.messages.push(converted);
      }
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          result.tools.push({
            type: "function",
            function: {
              name: func.name,
              description: func.description || "",
              parameters: func.parameters || { type: "object", properties: {} }
            }
          });
        }
      }
    }
  }

  return result;
}

// Convert Gemini content to OpenAI message
function convertGeminiContent(content) {
  const role = content.role === "user" ? "user" : "assistant";
  
  if (!content.parts || !Array.isArray(content.parts)) {
    return null;
  }

  const parts = [];
  const toolCalls = [];

  for (const part of content.parts) {
    if (part.text !== undefined) {
      parts.push({ type: "text", text: part.text });
    }

    if (part.inlineData) {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
        }
      });
    }

    if (part.functionCall) {
      toolCalls.push({
        // Gemini lacks a native call id; derive a deterministic one from the function
        // name so the matching functionResponse below produces the same tool_call_id.
        // Without this, providers reject the follow-up tool message with a 400
        // because the random id never matches. (port of upstream aba4c45)
        id: part.functionCall.id || `call_${part.functionCall.name}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }

    if (part.functionResponse) {
      return {
        role: "tool",
        // Mirror the same deterministic id shape so functionCall ↔ functionResponse pair.
        tool_call_id: part.functionResponse.id || `call_${part.functionResponse.name}`,
        content: JSON.stringify(part.functionResponse.response?.result || part.functionResponse.response || {})
      };
    }
  }

  if (toolCalls.length > 0) {
    const result = { role: "assistant" };
    if (parts.length > 0) {
      result.content = parts.length === 1 ? parts[0].text : parts;
    }
    result.tool_calls = toolCalls;
    return result;
  }

  if (parts.length > 0) {
    return {
      role,
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts
    };
  }

  return null;
}

// Extract text from Gemini content
function extractGeminiText(content) {
  if (typeof content === "string") return content;
  if (content.parts && Array.isArray(content.parts)) {
    return content.parts.map(p => p.text || "").join("");
  }
  return "";
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, geminiToOpenAIRequest, null);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, geminiToOpenAIRequest, null);

