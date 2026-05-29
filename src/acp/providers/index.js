'use strict';

const { OpenAIProvider } = require('./openai');
const { AnthropicProvider } = require('./anthropic');

const SUPPORTED_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-4-20250514', models: ['claude-sonnet-4-20250514', 'claude-haiku-3-20250414'] },
  { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3'] },
  { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'ollama', name: 'Ollama (local)', defaultModel: 'llama3.1', models: [] },
  { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4', models: [] },
  { id: 'azure', name: 'Azure OpenAI', defaultModel: 'gpt-4o', models: [] },
  { id: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', models: [] },
  { id: 'together', name: 'Together AI', defaultModel: 'meta-llama/Llama-3-70b-chat-hf', models: [] },
];

const DEFAULT_BASE_URLS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
};

class ProviderRegistry {
  constructor() {
    this._active = null;
    this._config = null;
  }

  /**
   * list() — Returns supported providers for ACP providers/list.
   */
  list() {
    return SUPPORTED_PROVIDERS.map(p => ({
      id: p.id,
      name: p.name,
      defaultModel: p.defaultModel,
      models: p.models,
    }));
  }

  /**
   * set(params) — Configures the active provider from ACP providers/set.
   * params: { providerId, apiKey, baseUrl?, model? }
   */
  set(params) {
    const { providerId, apiKey, baseUrl, model } = params;
    const providerDef = SUPPORTED_PROVIDERS.find(p => p.id === providerId);
    if (!providerDef) throw new Error(`Unknown provider: ${providerId}`);

    const resolvedModel = model || providerDef.defaultModel;
    const resolvedUrl = baseUrl || DEFAULT_BASE_URLS[providerId] || '';

    this._config = { providerId, apiKey, baseUrl: resolvedUrl, model: resolvedModel };

    if (providerId === 'anthropic') {
      this._active = new AnthropicProvider(apiKey, resolvedUrl, resolvedModel);
    } else {
      // All others use OpenAI-compatible API
      this._active = new OpenAIProvider(apiKey, resolvedUrl, resolvedModel);
    }
  }

  /**
   * disable() — Clears the active provider.
   */
  disable() {
    this._active = null;
    this._config = null;
  }

  /**
   * getActive() — Returns the active provider instance or null.
   */
  getActive() {
    return this._active;
  }
}

module.exports = { ProviderRegistry, SUPPORTED_PROVIDERS };
