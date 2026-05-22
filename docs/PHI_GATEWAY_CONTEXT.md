# PHI Gateway Context

## Original Problem

The PHI backend is on shared hosting and outbound internet calls fail unless the destination IP is allowlisted. The backend can call the Logitaka VPS if its IP is allowlisted.

The VPS IP verified from DNS and outbound check:

- `app.logitaka.com` -> `188.245.144.148`
- `ops.logitaka.com` -> `188.245.144.148`
- VPS outbound IP -> `188.245.144.148`

So PHI can whitelist `188.245.144.148` and call a dedicated gateway hosted there.

## Existing Logitaka Facts To Reuse Conceptually

Logitaka already has an OpenAI-compatible proxy:

- `GET https://app.logitaka.com/v1/models`
- `POST https://app.logitaka.com/v1/chat/completions`

Live Logitaka proxy state, sanitized:

```json
{
  "schema_version": 1,
  "updated_at": "2026-03-30T18:43:21.590Z",
  "enabled": true,
  "public_model_id": "logitaka-default",
  "current_model_key": "openrouter_claude_opus",
  "model_aliases_present": false,
  "clients": [
    {
      "client_id": "cline-main",
      "label": "VSCode Cline",
      "enabled": true,
      "key_hint": "...92c0"
    }
  ]
}
```

Important: Logitaka currently has one public model alias only. PHI should not depend on that single alias.

## Desired Dedicated PHI Gateway

Use the same architectural idea, but with its own service:

- separate service root: `/opt/phi-gateway`
- separate client keys
- separate provider config
- separate usage/debug logs
- separate public API routes

## Suggested Config Concept

```json
{
  "schema_version": 1,
  "enabled": true,
  "clients": [
    {
      "client_id": "phi-backend",
      "label": "PHI shared-hosting backend",
      "enabled": true,
      "key_hash": "scrypt$...",
      "key_hint": "...abcd",
      "allowed_model_aliases": [
        "phi-parser",
        "phi-classifier",
        "phi-vision",
        "phi-audio-transcriber"
      ]
    }
  ],
  "model_aliases": {
    "phi-parser": {
      "enabled": true,
      "target_model_key": "openrouter_qwen_reasoning",
      "fallback_model_keys": ["openrouter_claude_sonnet", "zai_glm51"],
      "required_capabilities": ["text_input", "text_output", "structured_output"]
    },
    "phi-classifier": {
      "enabled": true,
      "target_model_key": "openai_gpt54_nano",
      "fallback_model_keys": ["zai_free", "alibaba_qwen_flash"],
      "required_capabilities": ["text_input", "text_output", "structured_output", "fast"]
    },
    "phi-vision": {
      "enabled": true,
      "target_model_key": "openrouter_qwen_reasoning",
      "fallback_model_keys": ["openrouter_claude_sonnet", "moonshot_kimi"],
      "required_capabilities": ["text_input", "image_input", "text_output", "structured_output"]
    },
    "phi-audio-transcriber": {
      "enabled": true,
      "target_model_key": "google_gemini_flash_lite",
      "fallback_model_keys": ["gemini_flash_latest", "openai_gpt4o_transcribe"],
      "required_capabilities": ["audio_input", "text_output", "transcription"]
    }
  }
}
```

The exact model keys can change when the new gateway gets real provider configs.

## Implementation Notes

- Start with OpenAI-compatible `/v1/chat/completions` for text/vision aliases.
- For audio, prefer a dedicated `POST /phi/audio/transcribe` first. Do not force audio into generic chat completions until the request formats are deliberately supported.
- Keep e-Kassa as a tool endpoint, not as a model alias.
- Log request metadata, model alias, resolved provider/model, latency, status, and compact errors.
- Never log bearer tokens or provider API keys.

