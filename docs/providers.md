# Provider Setup

Each AI provider needs an API key and, optionally, quota configuration in `agentforge.yml`.
This guide covers how to get credentials and how to configure each provider.

AgentForge has adapters for five providers: Anthropic, Google, DeepSeek, OpenRouter, and Ollama.
Each task is one non-streaming request. The orchestrator sends no tool definitions, so models only return text.

---

## Anthropic (Claude)

**Models:** claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5

### Get an API key

1. Sign in at [console.anthropic.com](https://console.anthropic.com)
2. Go to **API Keys** → **Create Key**
3. Copy the key (starts with `sk-ant-`)

### Configure

```yaml
providers:
  anthropic:
    enabled: true
    api_key: ${ANTHROPIC_API_KEY}
    quota:
      max_requests_per_minute: 100    # Adjust to your plan
      max_tokens_per_minute: 400000   # Input tokens only
      auto_pause: true
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Quota limits

Set `max_requests_per_minute` and `max_tokens_per_minute` to the rate limits that the Anthropic console shows for your organization. AgentForge counts only input tokens against `max_tokens_per_minute`.

### Custom endpoint (proxy)

```yaml
providers:
  anthropic:
    endpoint: https://my-proxy.example.com   # Must implement Anthropic Messages API
```

---

## Google (Gemini)

**Models:** gemini-4-argon, gemini-3.8-flash

### Get an API key

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API key** → **Create API key**
3. Copy the key (starts with `AIza...`)

### Configure

```yaml
providers:
  google:
    enabled: true
    api_key: ${GOOGLE_AI_KEY}
    quota:
      max_requests_per_minute: 60     # Adjust to your plan
      auto_pause: true
```

```bash
export GOOGLE_AI_KEY=AIza...
```

The Google adapter ignores `endpoint`.

### Why use Gemini?

Gemini 4 Argon has a **1 million token context window**. A routing rule can send large-context tasks to it:

```yaml
routing:
  rules:
    - match: { context_tokens_gt: 200000 }
      force: gemini-4-argon
```

This rule does not fire on a task's first dispatch today, because the orchestrator estimates context size only after it routes the task. See [Configuration Reference → routing](configuration.md#matchers).

### Quota limits

Set `max_requests_per_minute` to the limit that Google AI Studio shows for your project.

---

## DeepSeek

**Models:** deepseek-flash, deepseek-v4-pro

DeepSeek uses an OpenAI-compatible API. The adapter uses the `openai` SDK with DeepSeek's endpoint.

### Get an API key

1. Sign up at [platform.deepseek.com](https://platform.deepseek.com)
2. Go to **API Keys** → **Create new secret key**

### Configure

```yaml
providers:
  deepseek:
    enabled: true
    api_key: ${DEEPSEEK_API_KEY}
    endpoint: https://api.deepseek.com
    quota:
      max_requests_per_minute: 120
      auto_pause: true
```

```bash
export DEEPSEEK_API_KEY=sk-...
```

### Model guidance

| Model | Use for | Notes |
|---|---|---|
| `deepseek-flash` | Bulk/T3 tasks | Very cheap ($0.30/$1.20 per 1M at peak, half off-peak), fast |
| `deepseek-v4-pro` | Complex reasoning / T2 fallback | Chain-of-thought, slower |

---

## Ollama (local)

Run models locally. No API key, no cost, no quota limits.

### Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows: download from https://ollama.com/download
```

### Pull a model

```bash
ollama pull codestral          # 22B coding model (~13 GB)
ollama pull deepseek-r1:32b   # DeepSeek R1 32B (~20 GB)
ollama pull llama3.2:3b       # Lightweight option (~2 GB)
```

### Configure

```yaml
providers:
  ollama:
    enabled: true
    endpoint: http://localhost:11434   # Default Ollama address
```

Register the local models:

```yaml
models:
  codestral:22b:
    provider: ollama
    tier: 3
    cost_in: 0
    cost_out: 0
    context: 32000

  deepseek-r1:32b:
    provider: ollama
    tier: 3
    cost_in: 0
    cost_out: 0
    context: 128000
```

### Docker + Ollama

Use the `local` profile in `docker-compose.yml` to start the Ollama service:

```bash
docker compose --profile local up -d ollama
```

Start AgentForge itself as [Deployment](deployment.md#docker) describes.

Ollama is accessible at `http://ollama:11434` from inside the compose network.
Update your config endpoint accordingly:

```yaml
providers:
  ollama:
    endpoint: http://ollama:11434
```

---

## OpenRouter

OpenRouter proxies many models through a single API key. Use it for models that
have no direct adapter.

### Get an API key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Go to **Keys** → **Create key**

### Configure

```yaml
providers:
  openrouter:
    enabled: true
    api_key: ${OPENROUTER_API_KEY}
    endpoint: https://openrouter.ai/api/v1   # Default
    quota:
      max_requests_per_minute: 60
```

AgentForge has no daily spend cap per provider. Use `project.budget` to cap spend.

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Register models via OpenRouter using their `<provider>/<model>` naming:

```yaml
models:
  openai/gpt-6.1-sol:
    provider: openrouter
    tier: 2
    cost_in: 2.00
    cost_out: 10.00
    context: 1050000

  meta-llama/llama-3.3-70b-instruct:
    provider: openrouter
    tier: 3
    cost_in: 0.10
    cost_out: 0.32
    context: 131072
```

---

## Other providers

There is no OpenAI or Moonshot adapter. `createAgentForge()` ignores `providers.openai`, `providers.moonshot`, and any other provider ID. To reach OpenAI models, register them under the `openrouter` provider.

---

## Provider priority and fallback

The router tries models in this order when a task is dispatched:

1. The task's `force_model`, if set. The API and CLI do not set it.
2. The agent's `model`, then its `fallback_models` in order.
3. Each routing rule that matches, in order: `force`, or `prefer`, then `fallback`, then any model in the rule's `tier`.
4. The cheapest available model in the tier for the task type, local (cost 0) models first.
5. Each lower tier, in the same order.
6. If no model is available, the task moves to `waiting_quota`.

A task returns from `waiting_quota` to the queue on the `quota.reset` event. The quota tracker emits that event only when a provider goes straight from `exhausted` to `available`. A provider that passes through `throttled` on its way down does not emit it, and its waiting tasks stay in `waiting_quota`.

There is no agent setting `allow_tier_downgrade`. The router checks `allow_tier_downgrade` on the task, and neither the API nor the CLI sets it, so tier downgrade is always allowed.

---

## Testing provider connectivity

From the dashboard → **Providers** → click **Test Connection** on any provider card.

This check confirms only that the provider is registered. No adapter implements a `test()` method, so the server makes no network call and reports `reachable` for every registered provider. The startup log shows the real Ollama health check.

Or via API:

```bash
curl -X POST http://localhost:4242/api/providers/test \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic"}'
# → {"ok":true,"provider":"anthropic","status":"reachable"}
```
