# puter-2api (v2.0 Pro) 🚀

[![部署](https://img.shields.io/badge/部署-Cloudflare%20Worker-orange)](https://workers.cloudflare.com/)
[![免费额度](https://img.shields.io/badge/CF免费额度-10万次/天-success)](https://workers.cloudflare.com/)
[![协议](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](./LICENSE)

**将 Puter.com 的强大 AI 能力，封装为标准的 OpenAI API（Chat Completions / Models / Images）。零服务器成本，通过 Cloudflare Workers 一键部署！**

本项目基于原版进行了深度重构与修复，解决了原版 **Token 失效、强制流式导致 SDK 崩溃、虚构不存在模型** 等致命问题，是一个真正开箱即用、健壮稳定的代理网关。

---

## 🌟 v2.0 重大更新与修复特性

* 🚀 **完整支持流式与非流式**：
  * 原版强制 `stream: true`，导致 Python SDK、LangChain 或其他未开启 stream 的客户端直接报错。
  * v2.0 完整支持 `stream: true` (SSE) 和 `stream: false` (标准 JSON)，100% 兼容全生态。
* 🔑 **灵活的凭证管理与动态透传**：
  * 告别原版硬编码失效 Token 的问题。
  * **支持请求头透传**：客户端请求可携带 `X-Puter-Auth-Token`，实现多用户按需使用各自账号。
  * **支持环境变量凭证池**：在 Cloudflare Worker 中配置 `PUTER_AUTH_TOKENS`，支持多个账号轮询与故障自动重试。
  * **支持主密钥保护**：配置 `API_MASTER_KEY` 防止私有 Worker 被盗刷。
* 🎯 **去伪存真的真实模型支持**：
  * 清除了虚构的 `gpt-5.1`、`sora-2` 等不存在模型。
  * 支持 Puter 官方真实可用的模型：`gpt-4o-mini`, `gpt-4o`, `claude-3-5-sonnet`, `gemini-2.0-flash`, `deepseek-chat`, `deepseek-reasoner` 等。
* 🖥️ **全新交互式开发者控制台**：
  * 访问根路径 `/` 即可打开控制台。支持在浏览器端输入自己的 Puter Token 实时调试，提供主流客户端一键复制配置。

---

## 🔑 第一步：获取免费 Puter Auth Token

Puter 为注册用户提供了免费的 AI 额度，获取 Token 只需 10 秒：

1. 访问 [Puter.com](https://puter.com/) 并注册/登录账号。
2. 打开 [puter.com/dashboard](https://puter.com/dashboard)。
3. 点击页面右上角的**个人头像 / 账户设置**。
4. 点击 **"Reveal Auth Token"**（或 "Create token"）复制长串 JWT 凭证（以 `eyJ...` 开头）。

> 💡 也可以使用 Puter 官方 CLI 在终端获取：`npx @heyputer/puter-cli login`。

---

## 🚀 部署指南

### 方式一：Cloudflare 控制台快速部署（推荐新手）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers 和 Pages**。
2. 点击 **创建应用程序** -> **创建 Worker**，输入名称（例如 `my-puter-api`），点击**部署**。
3. 部署后点击 **编辑代码**，将本项目中的 [`worker.js`](./worker.js) 内容完整复制并替换原有代码，点击 **部署 (Deploy)**。
4. **配置环境变量**（重要）：
   * 进入 Worker 的 **设置 (Settings)** -> **变量 (Variables)**。
   * 添加变量 `PUTER_AUTH_TOKENS`：填入你刚才获取的 Puter Token（支持多个 Token，用逗号 `,` 分隔）。
   * （可选）添加变量 `API_MASTER_KEY`：设置你的专属访问密码（例如 `sk-my-secret-key`）。
5. 保存并重新部署，访问分配的 `https://<你的Worker>.workers.dev` 即可查看控制台！

---

### 方式二：使用 Wrangler 命令行部署

克隆本项目并一键部署：

```bash
git clone https://github.com/dongsuo/puterjs-2api-cfwork.git
cd puterjs-2api-cfwork
npm install

# 登录 Cloudflare
npx wrangler login

# 部署
npm run deploy
```

部署完成后，在 Cloudflare 控制台添加环境变量，或在 `wrangler.toml` 中配置即可。

---

## 📱 客户端配置示例

### 1. NextChat (ChatGPT-Next-Web)
* **接口地址 (Base URL)**: `https://<你的Worker>.workers.dev/v1`
* **API Key**: 填入你设置的 `API_MASTER_KEY`（若未开启主密钥，可填任意值或直接填 Puter Token）。
* **自定义模型**: `+gpt-4o-mini,+gpt-4o,+claude-3-5-sonnet,+gemini-2.0-flash,+deepseek-chat`

### 2. LobeChat / Cherry Studio / Cursor
* **API 地址**: `https://<你的Worker>.workers.dev/v1`
* **API Key**: 填入 `API_MASTER_KEY` 或 Puter Token。

### 3. Python OpenAI SDK
```python
import openai

client = openai.OpenAI(
    base_url="https://<你的Worker>.workers.dev/v1",
    api_key="your-master-key"  # 或直接填 Puter Token
)

# 1. 流式输出
stream = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "你好，请介绍一下你自己"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")

# 2. 非流式调用 (v2.0 已完美支持)
res = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "1+1等于几？"}],
    stream=False
)
print(res.choices[0].message.content)
```

### 4. cURL 命令行
```bash
# 流式请求
curl https://<你的Worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-master-key" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# 携带自定义 Puter Token (即使 Worker 没有全局 Token 也能用)
curl https://<你的Worker>.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Puter-Auth-Token: eyJhbGciOi..." \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## ⚙️ 环境变量说明

| 变量名 | 必填 | 默认值 | 说明 |
| :--- | :---: | :---: | :--- |
| `PUTER_AUTH_TOKENS` | 推荐 | 无 | 服务端 Puter Token 凭证池。支持单个 Token，或逗号分隔的多个 Token，或 JSON 数组格式。 |
| `API_MASTER_KEY` | 可选 | 空 | 访问网关的主密钥。配置后客户端必须带上该 Bearer Key 才能调用服务端的凭证池。 |

---

## 📄 开源许可证

本项目基于 [Apache License 2.0](./LICENSE) 协议开源。
仅供个人开发、学习与测试使用，请遵循 Puter.com 服务条款。
