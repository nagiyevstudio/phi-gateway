# PHI API Contract Draft

## Auth

All non-health routes require:

```http
Authorization: Bearer <PHI_GATEWAY_API_KEY>
```

The service stores only a hash and a short key hint for this client key.

## Health

```http
GET /health
```

Response:

```json
{
  "ok": true,
  "service": "phi-gateway"
}
```

## Models

```http
GET /v1/models
```

Response should be OpenAI-compatible enough for clients:

```json
{
  "object": "list",
  "data": [
    { "id": "phi-parser", "object": "model", "created": 0, "owned_by": "phi-gateway" },
    { "id": "phi-classifier", "object": "model", "created": 0, "owned_by": "phi-gateway" },
    { "id": "phi-vision", "object": "model", "created": 0, "owned_by": "phi-gateway" },
    { "id": "phi-audio-transcriber", "object": "model", "created": 0, "owned_by": "phi-gateway" }
  ]
}
```

## Chat Completions

```http
POST /v1/chat/completions
```

Request:

```json
{
  "model": "phi-parser",
  "messages": [
    { "role": "system", "content": "Return JSON only." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0,
  "response_format": { "type": "json_object" }
}
```

Rules:

- `model` must be one of the public PHI aliases.
- Alias resolves to a private provider/model target.
- The response `model` should be the public alias, not the private upstream id.
- Unsupported tools/function calling must be clearly rejected until implemented.

## e-Kassa Receipt Image

```http
POST /phi/ekassa/receipt-image
```

Request:

```json
{
  "qr_url": "https://monitoring.e-kassa.gov.az/#/index?doc={FISCAL_ID}",
  "fiscal_id": "{FISCAL_ID}"
}
```

At least one of `qr_url` or `fiscal_id` is required.

Fiscal ID extraction:

```regex
doc=([A-HJ-NP-Za-km-z1-9]{42,46})
```

Raw fiscal ID validation:

```regex
^[A-HJ-NP-Za-km-z1-9]{42,46}$
```

Download URL:

```text
https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/{FISCAL_ID}
```

Valid upstream HTTP statuses:

- `200`
- `206`

Known not-found status:

- `209`

Response:

```json
{
  "success": true,
  "data": {
    "fiscal_id": "{FISCAL_ID}",
    "image_base64": "...",
    "mime_type": "image/jpeg"
  }
}
```

## Audio Transcription

```http
POST /phi/audio/transcribe
```

Preferred first version: multipart form upload.

Form fields:

- `audio`: file
- `mode`: optional, for example `plain`, `receipt`, or `note`

Response:

```json
{
  "success": true,
  "data": {
    "transcript": "...",
    "normalized_text": null,
    "model": "phi-audio-transcriber"
  }
}
```

## Receipt Parse

```http
POST /phi/receipt/parse
```

Possible request:

```json
{
  "image_base64": "...",
  "mime_type": "image/jpeg",
  "hint": "optional extra context"
}
```

Response should be PHI-specific JSON. Define the final schema after inspecting PHI's current parser expectations.

