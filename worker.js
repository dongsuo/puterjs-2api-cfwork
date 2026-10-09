// =================================================================================
//  项目: puter-2api (Cloudflare Worker 版)
//  版本: 2.0.0-pro (Puter.js to OpenAI API Gateway)
//  作者: dongsuo
//  协议: Apache License 2.0
//
//  特性:
//  1. 完整兼容 OpenAI /v1/chat/completions (同时支持流式 Stream 和非流式 JSON)
//  2. 兼容 /v1/models 与 /v1/images/generations
//  3. 支持通过请求头 (X-Puter-Auth-Token) 或环境变量 (PUTER_AUTH_TOKENS) 灵活鉴权
//  4. 支持主密钥 (API_MASTER_KEY) 保护与多 Token 自动轮询与故障重试
//  5. 内置现代化 Web 调试终端与主流客户端 (LobeChat / NextChat / Cursor 等) 配置指引
// =================================================================================

const CONFIG = {
  PROJECT_NAME: "puter-2api",
  PROJECT_VERSION: "2.0.0-pro",
  UPSTREAM_URL: "https://api.puter.com/drivers/call",
  MODELS_LIST_URL: "https://api.puter.com/puterai/chat/models/",
  DEFAULT_CHAT_MODEL: "gpt-4o-mini",
  DEFAULT_IMAGE_MODEL: "gpt-image-1",

  // 常用真实可用模型列表
  COMMON_CHAT_MODELS: [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-4-turbo",
    "o1-mini",
    "o1-preview",
    "o3-mini",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-haiku",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "deepseek-chat",
    "deepseek-reasoner",
    "grok-2",
    "grok-beta",
    "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen-2.5-72b-instruct"
  ],
  IMAGE_MODELS: ["gpt-image-1"]
};

// 全局轮询指针
let globalTokenIndex = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleCorsPreflight();
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return handleUI(request, env);
    } else if (url.pathname.startsWith("/v1/")) {
      return handleApi(request, env, ctx);
    } else {
      return createErrorResponse(`未找到路径: ${url.pathname}`, 404, "not_found");
    }
  }
};

// ==========================================
// 核心 API 路由与鉴权处理
// ==========================================

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  // 1. 获取运行时配置
  const runtimeConfig = getRuntimeConfig(env);

  // 2. /v1/models 接口不需要 Puter Auth Token，仅在开启主密钥时校验权限
  if (url.pathname === "/v1/models") {
    if (runtimeConfig.API_MASTER_KEY && runtimeConfig.API_MASTER_KEY !== "1") {
      const authHeader = request.headers.get("Authorization") || "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (bearerToken !== runtimeConfig.API_MASTER_KEY) {
        return createErrorResponse("无效的 API Key。", 403, "invalid_api_key");
      }
    }
    return handleModelsRequest(env);
  }

  // 3. 鉴权与获取 Puter Token (用于生成任务)
  const authResult = resolveAuthAndPuterToken(request, runtimeConfig);
  if (!authResult.success) {
    return createErrorResponse(authResult.error, authResult.status, authResult.code);
  }

  // 4. 路由分发
  switch (url.pathname) {
    case "/v1/chat/completions":
      return handleChatCompletions(request, env, authResult.tokens, requestId);
    case "/v1/images/generations":
      return handleImageGenerations(request, env, authResult.tokens, requestId);
    default:
      return createErrorResponse(`API 路径不支持: ${url.pathname}`, 404, "not_found");
  }
}

/**
 * 解析主密钥认证与 Puter Token 池
 */
function resolveAuthAndPuterToken(request, config) {
  const authHeader = request.headers.get("Authorization") || "";
  const customPuterToken = request.headers.get("X-Puter-Auth-Token") || request.headers.get("X-Puter-Token");

  // 优先使用请求头显式传递的 Puter Token
  if (customPuterToken) {
    return { success: true, tokens: [customPuterToken.trim()] };
  }

  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  // 如果配置了主密钥保护
  if (config.API_MASTER_KEY && config.API_MASTER_KEY !== "1") {
    if (!bearerToken) {
      return {
        success: false,
        status: 401,
        code: "unauthorized",
        error: "缺少认证密钥。请在 Authorization 请求头中传入 Bearer <API_MASTER_KEY>，或传入 X-Puter-Auth-Token。"
      };
    }

    if (bearerToken !== config.API_MASTER_KEY) {
      // 允许用户直接将 Puter JWT Token 作为 Bearer Token 传入
      if (bearerToken.startsWith("eyJ")) {
        return { success: true, tokens: [bearerToken] };
      }
      return {
        success: false,
        status: 403,
        code: "invalid_api_key",
        error: "无效的 API Key。"
      };
    }
  } else {
    // 未开启主密钥保护时，如果用户传了 Puter JWT，直接优先使用
    if (bearerToken && bearerToken.startsWith("eyJ")) {
      return { success: true, tokens: [bearerToken] };
    }
  }

  // 使用服务端的 Puter 凭证池
  if (!config.PUTER_AUTH_TOKENS || config.PUTER_AUTH_TOKENS.length === 0) {
    return {
      success: false,
      status: 401,
      code: "missing_puter_token",
      error: "未配置有效的 Puter Auth Token。请在 Cloudflare Worker 环境变量中设置 PUTER_AUTH_TOKENS，或在请求头中传入 X-Puter-Auth-Token。前往 https://puter.com/dashboard 即可获取。"
    };
  }

  return { success: true, tokens: config.PUTER_AUTH_TOKENS };
}

function getRuntimeConfig(env) {
  let tokens = [];

  if (env && env.PUTER_AUTH_TOKENS) {
    try {
      const parsed = JSON.parse(env.PUTER_AUTH_TOKENS);
      if (Array.isArray(parsed)) tokens = parsed;
    } catch (e) {
      tokens = env.PUTER_AUTH_TOKENS.split(",").map(t => t.trim()).filter(Boolean);
    }
  }

  if (env && env.PUTER_AUTH_TOKEN) {
    tokens.push(env.PUTER_AUTH_TOKEN.trim());
  }

  const masterKey = (env && env.API_MASTER_KEY !== undefined) ? env.API_MASTER_KEY : "";

  return {
    ...CONFIG,
    API_MASTER_KEY: masterKey,
    PUTER_AUTH_TOKENS: tokens
  };
}

function getNextToken(tokenList) {
  if (!tokenList || tokenList.length === 0) return null;
  const token = tokenList[globalTokenIndex % tokenList.length];
  globalTokenIndex = (globalTokenIndex + 1) % tokenList.length;
  return token;
}

// ==========================================
// Chat Completions (支持流式与非流式)
// ==========================================

async function handleChatCompletions(request, env, tokens, requestId) {
  let requestData;
  try {
    requestData = await request.json();
  } catch (e) {
    return createErrorResponse("请求体不是合法的 JSON 格式。", 400, "invalid_json");
  }

  const isStream = requestData.stream === true;
  const model = requestData.model || CONFIG.DEFAULT_CHAT_MODEL;
  const maxRetries = Math.min(tokens.length, 3);

  let lastError = null;
  let lastStatus = 500;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const currentToken = getNextToken(tokens);
    const driver = getDriverFromModel(model);

    const upstreamPayload = {
      interface: "puter-chat-completion",
      driver: driver,
      test_mode: false,
      method: "complete",
      args: {
        messages: requestData.messages || [],
        model: model,
        stream: true // 上游始终以 stream 调用，以避免长响应超时
      },
      auth_token: currentToken
    };

    const upstreamHeaders = {
      "Content-Type": "application/json",
      "Accept": isStream ? "text/event-stream" : "*/*",
      "Origin": "https://docs.puter.com",
      "Referer": "https://docs.puter.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "X-Request-ID": requestId,
      "Authorization": `Bearer ${currentToken}`
    };

    try {
      const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamPayload)
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        lastStatus = upstreamResponse.status;
        lastError = errorText;

        // 如果是 401 凭证失效或 429 限流，尝试轮换下一个 token
        if ((upstreamResponse.status === 401 || upstreamResponse.status === 429) && attempt < maxRetries - 1) {
          console.warn(`Token 认证失败或被限流 (${upstreamResponse.status})，尝试使用备用 Token...`);
          continue;
        }

        return parseAndReturnUpstreamError(errorText, upstreamResponse.status);
      }

      if (!upstreamResponse.body) {
        return createErrorResponse("上游服务未返回响应正文。", 502, "bad_gateway");
      }

      // 分支 A: 客户端请求流式 (Stream)
      if (isStream) {
        const transformStream = createUpstreamToOpenAIStream(requestId, model);
        return new Response(upstreamResponse.body.pipeThrough(transformStream), {
          headers: corsHeaders({
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Request-ID": requestId
          })
        });
      }

      // 分支 B: 客户端请求非流式 (Non-stream JSON)
      const accumulated = await accumulateStreamResponse(upstreamResponse.body);
      const responseJson = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: accumulated.content,
              ...(accumulated.reasoning ? { reasoning_content: accumulated.reasoning } : {})
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: Math.ceil(accumulated.content.length / 4),
          total_tokens: Math.ceil(accumulated.content.length / 4)
        }
      };

      return new Response(JSON.stringify(responseJson), {
        headers: corsHeaders({
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-ID": requestId
        })
      });

    } catch (err) {
      lastError = err.message;
      if (attempt < maxRetries - 1) continue;
    }
  }

  return createErrorResponse(`上游服务调用失败: ${lastError}`, lastStatus, "upstream_error");
}

function getDriverFromModel(model) {
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gemini")) return "gemini";
  if (model.startsWith("grok")) return "xai";
  if (model.startsWith("deepseek") || model.includes(":")) return "ai-chat";
  return "openai-completion";
}

/**
 * 将 Puter 上游流累积并转换为完整文本 (用于非流式请求)
 */
async function accumulateStreamResponse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoning = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 保持未结束行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let payload = trimmed;
      if (payload.startsWith("data: ")) payload = payload.slice(6).trim();
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        if (parsed.type === "text" && typeof parsed.text === "string") {
          fullContent += parsed.text;
        } else if (parsed.text && typeof parsed.text === "string") {
          fullContent += parsed.text;
        } else if (parsed.type === "reasoning" && typeof parsed.reasoning === "string") {
          fullReasoning += parsed.reasoning;
        } else if (parsed.choices?.[0]?.delta?.content) {
          fullContent += parsed.choices[0].delta.content;
        }
      } catch (e) {
        // 忽略非 JSON 行
      }
    }
  }

  return { content: fullContent, reasoning: fullReasoning };
}

/**
 * 流式转换器：Puter NDJSON/SSE -> OpenAI SSE 格式
 */
function createUpstreamToOpenAIStream(requestId, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let payload = trimmed;
        if (payload.startsWith("data: ")) payload = payload.slice(6).trim();
        if (payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          let deltaText = "";

          if (parsed.type === "text" && typeof parsed.text === "string") {
            deltaText = parsed.text;
          } else if (parsed.text && typeof parsed.text === "string") {
            deltaText = parsed.text;
          } else if (parsed.choices?.[0]?.delta?.content) {
            deltaText = parsed.choices[0].delta.content;
          }

          if (deltaText) {
            const chunkObj = {
              id: requestId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [
                {
                  index: 0,
                  delta: { content: deltaText },
                  finish_reason: null
                }
              ]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkObj)}\n\n`));
          }
        } catch (e) {
          // 忽略格式解析错误
        }
      }
    },
    flush(controller) {
      const finalChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    }
  });
}

// ==========================================
// Models List 接口
// ==========================================

async function handleModelsRequest(env) {
  const cacheKey = new Request("https://puter-2api.internal/cache/v1/models");
  const cache = caches.default;

  try {
    let cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch (e) {}

  let models = [...CONFIG.COMMON_CHAT_MODELS, ...CONFIG.IMAGE_MODELS];

  // 尝试从上游获取全量可用模型
  try {
    const upstreamRes = await fetch(CONFIG.MODELS_LIST_URL, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (upstreamRes.ok) {
      const data = await upstreamRes.json();
      if (Array.isArray(data.models)) {
        // 合并去重
        const set = new Set([...models, ...data.models]);
        models = Array.from(set);
      }
    }
  } catch (e) {
    // 降级使用内置预设
  }

  const responseData = {
    object: "list",
    data: models.map(m => ({
      id: m,
      object: "model",
      created: 1728518400,
      owned_by: "puter"
    }))
  };

  const response = new Response(JSON.stringify(responseData), {
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    })
  });

  try {
    await cache.put(cacheKey, response.clone());
  } catch (e) {}

  return response;
}

// ==========================================
// Image Generations 接口
// ==========================================

async function handleImageGenerations(request, env, tokens, requestId) {
  let requestData;
  try {
    requestData = await request.json();
  } catch (e) {
    return createErrorResponse("请求体不是合法的 JSON 格式。", 400, "invalid_json");
  }

  const currentToken = getNextToken(tokens);
  const upstreamPayload = {
    interface: "puter-image-generation",
    driver: "openai-image-generation",
    test_mode: false,
    method: "generate",
    args: {
      model: requestData.model || CONFIG.DEFAULT_IMAGE_MODEL,
      quality: requestData.quality || "high",
      prompt: requestData.prompt || ""
    },
    auth_token: currentToken
  };

  try {
    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://docs.puter.com",
        "Referer": "https://docs.puter.com/",
        "User-Agent": "Mozilla/5.0",
        "Authorization": `Bearer ${currentToken}`
      },
      body: JSON.stringify(upstreamPayload)
    });

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return parseAndReturnUpstreamError(errText, upstreamResponse.status);
    }

    const imageBytes = await upstreamResponse.arrayBuffer();
    const bytes = new Uint8Array(imageBytes);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64Json = btoa(binary);

    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: b64Json }]
    }), {
      headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" })
    });
  } catch (err) {
    return createErrorResponse(`图像生成失败: ${err.message}`, 500, "internal_error");
  }
}

// ==========================================
// 辅助与错误处理工具
// ==========================================

function parseAndReturnUpstreamError(errorBody, status) {
  try {
    const errorJson = JSON.parse(errorBody);
    if (errorJson.message) {
      return createErrorResponse(`上游错误: ${errorJson.message}`, status, errorJson.code || "upstream_error");
    }
    if (errorJson.error) {
      const msg = typeof errorJson.error === "string" ? errorJson.error : errorJson.error.message;
      return createErrorResponse(`上游错误: ${msg}`, status, errorJson.error.code || "upstream_error");
    }
  } catch (e) {}

  return createErrorResponse(`上游服务返回错误 (${status}): ${errorBody}`, status, "upstream_error");
}

function createErrorResponse(message, status = 500, code = "api_error") {
  return new Response(JSON.stringify({
    error: {
      message: message,
      type: "api_error",
      code: code
    }
  }), {
    status: status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" })
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Puter-Auth-Token, X-Puter-Token",
    ...extra
  };
}

// ==========================================
// 开发者驾驶舱 UI (Web Dashboard)
// ==========================================

function handleUI(request, env) {
  const origin = new URL(request.url).origin;
  const runtimeConfig = getRuntimeConfig(env);
  const hasServerTokens = runtimeConfig.PUTER_AUTH_TOKENS.length > 0;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} v${CONFIG.PROJECT_VERSION} - 开发者控制台</title>
    <style>
      :root {
        --bg-color: #0f172a;
        --sidebar-bg: #1e293b;
        --card-bg: #1e293b;
        --border-color: #334155;
        --text-color: #f8fafc;
        --text-secondary: #94a3b8;
        --primary: #38bdf8;
        --primary-hover: #0ea5e9;
        --input-bg: #0f172a;
        --success: #4ade80;
        --danger: #f87171;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: var(--bg-color);
        color: var(--text-color);
        display: flex;
        height: 100vh;
        overflow: hidden;
      }
      .layout { display: flex; width: 100%; height: 100vh; }
      .sidebar {
        width: 420px;
        flex-shrink: 0;
        background-color: var(--sidebar-bg);
        border-right: 1px solid var(--border-color);
        padding: 24px;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        gap: 20px;
      }
      .main-content {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        padding: 24px;
        overflow: hidden;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--border-color);
      }
      .logo { font-size: 20px; font-weight: 700; color: var(--primary); }
      .version { font-size: 12px; background: #334155; padding: 2px 8px; border-radius: 999px; margin-left: 8px; color: #cbd5e1; }
      .badge { font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600; }
      .badge-success { background: rgba(74, 222, 128, 0.2); color: var(--success); }
      .badge-warning { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
      
      .card {
        background: #182234;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 16px;
      }
      .card-title {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .field { margin-bottom: 12px; }
      .field label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
      .input-group { display: flex; gap: 8px; }
      input, select, textarea {
        background: var(--input-bg);
        border: 1px solid var(--border-color);
        color: var(--text-color);
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 13px;
        width: 100%;
        outline: none;
      }
      input:focus, select:focus, textarea:focus { border-color: var(--primary); }
      button {
        background: var(--primary);
        color: #0f172a;
        border: none;
        padding: 8px 14px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 13px;
        transition: 0.2s;
      }
      button:hover { background: var(--primary-hover); }
      .btn-secondary { background: #334155; color: var(--text-color); }
      .btn-secondary:hover { background: #475569; }

      .guide-code {
        background: #090d16;
        padding: 12px;
        border-radius: 6px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: #38bdf8;
        overflow-x: auto;
        white-space: pre-wrap;
        margin-top: 8px;
        position: relative;
      }
      .tabs { display: flex; gap: 6px; margin-bottom: 12px; }
      .tab-btn { background: #0f172a; color: var(--text-secondary); padding: 5px 12px; font-size: 12px; border-radius: 4px; }
      .tab-btn.active { background: var(--primary); color: #0f172a; }

      /* Live Terminal */
      .terminal {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: #182234;
        border: 1px solid var(--border-color);
        border-radius: 8px;
        overflow: hidden;
      }
      .terminal-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color);
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #1e293b;
      }
      .terminal-body {
        flex-grow: 1;
        padding: 16px;
        overflow-y: auto;
        font-family: var(--font-mono);
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
      }
      .terminal-footer {
        padding: 16px;
        border-top: 1px solid var(--border-color);
        background: #1e293b;
        display: flex;
        gap: 12px;
      }
      .helper-text { font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-top: 6px; }
    </style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="header">
      <div class="logo">${CONFIG.PROJECT_NAME}<span class="version">v${CONFIG.PROJECT_VERSION}</span></div>
      <span class="badge ${hasServerTokens ? 'badge-success' : 'badge-warning'}">
        ${hasServerTokens ? '已就绪 (服务端Token)' : '需配置Token'}
      </span>
    </div>

    <!-- API 连接信息 -->
    <div class="card">
      <div class="card-title">📡 API 接入地址</div>
      <div class="field">
        <label>Base URL (兼容 OpenAI 规范)</label>
        <div class="input-group">
          <input type="text" id="api-base-url" value="${origin}/v1" readonly>
          <button onclick="copyText('${origin}/v1')">复制</button>
        </div>
      </div>
      <div class="field">
        <label>API Key / Master Key</label>
        <div class="input-group">
          <input type="text" id="api-master-key" value="${runtimeConfig.API_MASTER_KEY || '空 (无需鉴权)'}" readonly>
          <button class="btn-secondary" onclick="copyText('${runtimeConfig.API_MASTER_KEY || 'sk-puter-proxy'}')">复制</button>
        </div>
      </div>
    </div>

    <!-- 本地 Puter Token 设置 -->
    <div class="card">
      <div class="card-title">🔑 自定义 Puter Token (浏览器端)</div>
      <p class="helper-text">若 Worker 环境变量未配置 Token，或想使用您自己的 Puter 额度，可在此处填入：</p>
      <div class="field" style="margin-top: 10px;">
        <input type="password" id="custom-token-input" placeholder="输入 eyJhbGciOi... (自动保存在本地)">
      </div>
      <div class="input-group">
        <button onclick="saveCustomToken()">保存凭证</button>
        <button class="btn-secondary" onclick="clearCustomToken()">清除</button>
      </div>
      <p class="helper-text" style="margin-top: 8px;">
        💡 <strong>如何获取？</strong> 登录 <a href="https://puter.com/dashboard" target="_blank" style="color:var(--primary);">puter.com/dashboard</a>，点击个人头像并选择 <strong>Reveal Auth Token</strong> 即可一键复制。
      </p>
    </div>

    <!-- 客户端快速接入 -->
    <div class="card">
      <div class="card-title">📱 客户端配置示例</div>
      <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('nextchat')">NextChat</button>
        <button class="tab-btn" onclick="switchTab('lobechat')">LobeChat</button>
        <button class="tab-btn" onclick="switchTab('python')">Python</button>
        <button class="tab-btn" onclick="switchTab('curl')">cURL</button>
      </div>
      <div id="guide-content" class="guide-code"></div>
    </div>
  </aside>

  <main class="main-content">
    <div class="terminal">
      <div class="terminal-header">
        <div style="display:flex; align-items:center; gap:12px;">
          <strong>在线测试终端 (Chat Playground)</strong>
          <select id="model-select" style="width: auto; padding: 4px 8px;">
            ${CONFIG.COMMON_CHAT_MODELS.map(m => `<option value="${m}">${m}</option>`).join("")}
          </select>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <label style="font-size:12px; color:var(--text-secondary);">
            <input type="checkbox" id="stream-checkbox" checked style="width:auto; margin-right:4px;"> 流式输出 (Stream)
          </label>
          <button class="btn-secondary" onclick="clearTerminal()">清屏</button>
        </div>
      </div>
      <div class="terminal-body" id="terminal-output">就绪。请在下方输入内容点击发送，测试与 Puter 驱动的连通性...</div>
      <div class="terminal-footer">
        <textarea id="prompt-input" rows="2" placeholder="输入测试问题 (例如: 你好，请用100字介绍你自己)..."></textarea>
        <button id="send-btn" onclick="sendPrompt()" style="height: 100%; min-width: 100px;">发送</button>
      </div>
    </div>
  </main>
</div>

<script>
  const BASE_URL = "${origin}/v1";
  const DEFAULT_KEY = "${runtimeConfig.API_MASTER_KEY || 'sk-puter-proxy'}";

  // 读取本地存储的 Token
  window.addEventListener("DOMContentLoaded", () => {
    const saved = localStorage.getItem("puter_custom_auth_token");
    if (saved) document.getElementById("custom-token-input").value = saved;
    switchTab('nextchat');
  });

  function saveCustomToken() {
    const val = document.getElementById("custom-token-input").value.trim();
    if (!val) { alert("请输入有效的 Token"); return; }
    localStorage.setItem("puter_custom_auth_token", val);
    alert("已成功保存至浏览器 localStorage！");
  }

  function clearCustomToken() {
    localStorage.removeItem("puter_custom_auth_token");
    document.getElementById("custom-token-input").value = "";
    alert("已清除本地 Token。");
  }

  function copyText(txt) {
    navigator.clipboard.writeText(txt);
    alert("已复制到剪贴板！");
  }

  function clearTerminal() {
    document.getElementById("terminal-output").textContent = "终端已清空。";
  }

  const GUIDES = {
    nextchat: "接口地址 (Base URL): " + BASE_URL + "\\nAPI Key: " + DEFAULT_KEY + "\\n自定义模型: +gpt-4o-mini,+gpt-4o,+claude-3-5-sonnet,+deepseek-chat",
    lobechat: "代理地址: " + BASE_URL + "\\nAPI Key: " + DEFAULT_KEY + "\\n支持全部 OpenAI 格式模型",
    python: "import openai\\n\\nclient = openai.OpenAI(\\n    base_url='" + BASE_URL + "',\\n    api_key='" + DEFAULT_KEY + "'\\n)\\n\\nres = client.chat.completions.create(\\n    model='gpt-4o-mini',\\n    messages=[{'role': 'user', 'content': 'Hello!'}],\\n    stream=True\\n)\\nfor chunk in res:\\n    print(chunk.choices[0].delta.content or '', end='')",
    curl: "curl " + BASE_URL + "/chat/completions \\\\\\n  -H 'Content-Type: application/json' \\\\\\n  -H 'Authorization: Bearer " + DEFAULT_KEY + "' \\\\\\n  -d '{\\n    \\\"model\\\": \\\"gpt-4o-mini\\\",\\n    \\\"messages\\\": [{\\\"role\\\": \\\"user\\\", \\\"content\\\": \\\"Hello!\\\"}],\\n    \\\"stream\\\": true\\n  }'"
  };

  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    event && event.target && event.target.classList.add("active");
    document.getElementById("guide-content").textContent = GUIDES[name];
  }

  async function sendPrompt() {
    const prompt = document.getElementById("prompt-input").value.trim();
    if (!prompt) return;

    const model = document.getElementById("model-select").value;
    const isStream = document.getElementById("stream-checkbox").checked;
    const outputEl = document.getElementById("terminal-output");
    const sendBtn = document.getElementById("send-btn");
    const customToken = localStorage.getItem("puter_custom_auth_token");

    outputEl.textContent = "⏳ 正在发起请求...\\n";
    sendBtn.disabled = true;

    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DEFAULT_KEY
    };
    if (customToken) {
      headers["X-Puter-Auth-Token"] = customToken;
    }

    try {
      const res = await fetch(BASE_URL + "/chat/completions", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          stream: isStream
        })
      });

      if (!res.ok) {
        const err = await res.text();
        outputEl.textContent = "❌ 请求失败 (" + res.status + "):\\n" + err;
        sendBtn.disabled = false;
        return;
      }

      if (!isStream) {
        const data = await res.json();
        outputEl.textContent = data.choices[0]?.message?.content || JSON.stringify(data, null, 2);
        sendBtn.disabled = false;
        return;
      }

      // 处理流式
      outputEl.textContent = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6).trim();
          if (payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload);
            const content = parsed.choices?.[0]?.delta?.content || "";
            outputEl.textContent += content;
            outputEl.scrollTop = outputEl.scrollHeight;
          } catch(e) {}
        }
      }
    } catch (e) {
      outputEl.textContent = "❌ 网络或执行异常: " + e.message;
    } finally {
      sendBtn.disabled = false;
    }
  }
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
