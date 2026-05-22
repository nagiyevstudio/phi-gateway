# PHI Gateway Agent Cold Start

Use this file first. This project is intentionally separate from Logitaka.

## Goal

Build a dedicated backend gateway for the PHI shared-hosting project.

The PHI backend can only call allowlisted IPs. The VPS public IP is:

- `188.245.144.148`

The gateway should run on that VPS and make outbound calls to AI providers and e-Kassa on PHI's behalf.

## Boundaries

- Do not place this service inside `/opt/logitaka` or the Logitaka repo.
- Keep PHI provider keys, PHI bearer keys, logs, and config separate from Logitaka.
- Do not copy Logitaka runtime code wholesale. Reuse patterns and facts only.
- Do not print or commit secrets.
- Store external client API keys as hashes plus hints, not plaintext.
- Keep the first implementation config-driven; add admin UI later only if needed.

## Suggested Local Shape

- Repo/workspace: `/Users/faignaghiyev/DEV/Feedback-end`
- Main docs:
  - `README.md`
  - `docs/PHI_GATEWAY_CONTEXT.md`
  - `docs/PHI_API_CONTRACT.md`
  - `docs/MODEL_INVENTORY_SANITIZED.md`
  - `docs/VPS_DEPLOY_RUNBOOK.md`

## Suggested VPS Shape

- App root: `/opt/phi-gateway`
- Config/secrets: `/opt/phi-gateway/config`
- Logs: `/opt/phi-gateway/logs`
- Service: `phi-gateway.service`
- Suggested local app port: `3200`
- Public base URL option: `https://phi-gateway.logitaka.com`

## Initial API Surface

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /phi/ekassa/receipt-image`
- `POST /phi/audio/transcribe`
- `POST /phi/receipt/parse`

## Public Model Aliases

- `phi-parser`
- `phi-classifier`
- `phi-vision`
- `phi-audio-transcriber`

## User Task Context

The user wants to open this folder as a fresh project so future agents do not carry Logitaka noise. Start from these docs, then scaffold the gateway.

