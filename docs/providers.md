# Provider Setup

Each AI provider needs an API key and quota configuration in `agentforge.yml`.
This guide covers obtaining credentials and recommended settings for each provider.

---

## Anthropic (Claude)

**Models:** claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5-20251001

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
      max_requests_per_minute: 100    # Tier 1 default; adjust to your plan
      max_tokens_per_minute: 400000
      auto_pause: true
      auto_resume: true
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Quota tiers

| Plan | Requests/min | Tokens/min |
|---|---|---|
| Free | 5 | 25,000 |
| Tier 1 | 50 | 50,000 |
| Tier 2 | 1,000 | 400,000 |
| Tier 4 | 4,000 | 400,000 |

Set `max_requests_per_minute` and `max_tokens_per_minute` to match your tier.

### Custom endpoint (proxy)

```yaml
providers:
  anthropic:
    endpoint: https://my-proxy.example.com   # Must implement Anthropic Messages API
```

---

## Google (Gemini)

**Models:** gemini-2.5-pro, gemini-2.5-flash

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
      max_requests_per_minute: 60     # Free tier default
      auto_pause: true
      auto_resume: true
```

```bash
export GOOGLE_AI_KEY=AIza...
```

### Why use Gemini?

Gemini 2.5 Pro has a **1 million token context window** — the only model in the
default registry that can handle prompts exceeding 200K tokens. The router
automatically routes large-context tasks to Gemini:

```yaml
routing:
  rules:
    - match: { context_tokens_gt: 200000 }
      force: gemini-2.5-pro
```

### Quota tiers

| Plan | Requests/min |
|---|---|
| Free (AI Studio) | 15 |
| Pay-as-you-go | 1,000 |

---

## DeepSeek

**Models:** deepseek-v3, deepseek-r1

DeepSeek uses an OpenAI-compatible API, making it easy to integrate.

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
      auto_resume: true
```

```bash
export DEEPSEEK_API_KEY=sk-...
```

### Model guidance

| Model | Use for | Notes |
|---|---|---|
| `deepseek-v3` | Bulk/T3 tasks | Very cheap ($0.27/$1.10 per 1M), fast |
| `deepseek-r1` | Complex reasoning / T2 fallback | Chain-of-thought, slower |

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
    context: 64000
```

### Docker + Ollama

Use the `ollama` profile in docker-compose to run both services:

```bash
docker-compose --profile ollama up
```

Ollama is accessible at `http://ollama:11434` from inside the compose network.
Update your config endpoint accordingly:

```yaml
providers:
  ollama:
    endpoint: http://ollama:11434
```

---

## OpenRouter

OpenRouter proxies hundreds of models through a single API key — useful as a
universal fallback or to access models not directly supported.

### Get an API key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Go to **Keys** → **Create key**

### Configure

```yaml
providers:
  openrouter:
    enabled: true
    api_key: ${OPENROUTER_API_KEY}
    endpoint: https://openrouter.ai/api
    quota:
      max_spend_per_day: 10.00    # Hard dollar cap per calendar day
```

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Register models via OpenRouter using their `<provider>/<model>` naming:

```yaml
models:
  openai/gpt-4o:
    provider: openrouter
    tier: 2
    cost_in: 2.50
    cost_out: 10.00
    context: 128000

  meta-llama/llama-3.3-70b-instruct:
    provider: openrouter
    tier: 3
    cost_in: 0.10
    cost_out: 0.30
    context: 128000
```

---

## OpenAI

**Models:** gpt-4o, gpt-4o-mini, o1, o3-mini

### Get an API key

1. Sign in at [platform.openai.com](https://platform.openai.com)
2. Go to **API Keys** → **Create new secret key**

### Configure

```yaml
providers:
  openai:
    enabled: true
    api_key: ${OPENAI_API_KEY}
    quota:
      max_requests_per_minute: 500
      auto_pause: true
      auto_resume: true
```

---

## Moonshot (Kimi)

OpenAI-compatible API from Moonshot AI.

```yaml
providers:
  moonshot:
    enabled: true
    api_key: ${MOONSHOT_API_KEY}
    endpoint: https://api.moonshot.cn
```

---

## Provider priority and fallback

The router tries providers in this order when a task is dispatched:

1. Agent's configured `model` (if quota available)
2. Agent's `fallback_models` list (in order)
3. Rule-based `fallback` list
4. `fallback_strategy: same_tier_then_downgrade` — same tier, different provider → tier downgrade
5. Local Ollama (if enabled and tier downgrade is permitted)
6. Task is re-queued and waits for quota to reset

Configure `allow_tier_downgrade: true` on agents that can safely use cheaper models when budget or quota is tight.

---

## Testing provider connectivity

From the dashboard → **Providers** → click **Test** on any provider card.

Or via API:

```bash
curl -X POST http://localhost:4242/api/providers/test \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic"}'
# → {"ok":true,"provider":"anthropic","status":"reachable"}
```
