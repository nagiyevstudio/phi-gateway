# Feedback-end / PHI Gateway

This folder is a clean handoff context for building a dedicated PHI backend gateway.

The key decision: keep PHI separate from Logitaka as a product, while still using the same VPS public IP for shared-hosting whitelist requirements.

## Why Separate

- PHI should have its own API keys, model routing, logs, and operational failures.
- Logitaka's current OpenAI-compatible proxy is for editor/Cline usage and should remain stable.
- PHI needs domain-specific tool endpoints, especially e-Kassa receipt access and parsing.
- A standalone service is easier to deploy, debug, rotate keys for, and eventually connect to Git.

## What To Build First

1. A small backend service with bearer auth.
2. OpenAI-compatible model aliases for PHI:
   - `phi-parser`
   - `phi-classifier`
   - `phi-vision`
   - `phi-audio-transcriber`
3. e-Kassa tool endpoint:
   - `POST /phi/ekassa/receipt-image`
4. Separate config with provider keys supplied manually by the user.
5. Minimal usage/debug logs with no secrets.

## Not In Scope For First Pass

- Full admin UI.
- Copying Logitaka code.
- Multi-tenant billing.
- Realtime voice sessions.
- Storing raw provider keys in git.

## Required Manual Secrets

The user should create and provide these outside git:

- PHI gateway bearer key for the shared-hosting backend.
- Provider API keys, depending on chosen providers:
  - OpenRouter
  - OpenAI
  - Google Gemini
  - Alibaba DashScope/Qwen, if used
  - Z.AI, if used

Store only hashes/hints for PHI client bearer keys. Provider keys can live in root-protected VPS config or environment files, never in repo.

