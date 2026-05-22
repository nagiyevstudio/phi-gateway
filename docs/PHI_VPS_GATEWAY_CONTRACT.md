# PHI VPS Gateway Contract

## Purpose

Build a VPS-side gateway for PHI smart functions.

PHI production backend is hosted on an environment without outbound internet access. It can call only allowlisted IPs. The VPS has outbound internet and already hosts the Logitaka OpenAI-compatible proxy.

The VPS gateway must perform external network and AI execution work, then return structured JSON to PHI. It must not take ownership of PHI business logic, PHI database writes, PHI user authorization, or PHI approval workflows.

## Hard Boundary

The VPS gateway is an execution layer only.

PHI backend keeps responsibility for:

- PHI user authentication and authorization.
- Reading user categories and category rules.
- Saving receipts, receipt items, pending operations, and final operations.
- User preview, edit, approve, and cancel workflows.
- Validating that returned category IDs belong to the PHI user.
- Validating monetary values and receipt totals before storing.
- All PHI database schema and lifecycle logic.

The VPS gateway owns only:

- External outbound calls.
- e-Kassa receipt image download.
- OCR / vision extraction.
- AI parsing and classification.
- Model/agent fallback routing.
- Returning normalized structured JSON to PHI.

Do not move PHI persistence logic to the VPS.
Do not make VPS write directly to the PHI database.
Do not add PHI user/session state to Logitaka unless explicitly requested later.

## Existing VPS Context

The VPS already serves Logitaka:

- Base URL: `https://app.logitaka.com/v1`
- Chat Completions: `https://app.logitaka.com/v1/chat/completions`
- Models: `https://app.logitaka.com/v1/models`
- Current public model: `logitaka-default`

Relevant existing files:

- `OS/apps/frontend/src/app/v1/chat/completions/route.ts`
- `OS/apps/frontend/src/app/v1/models/route.ts`
- `OS/apps/frontend/src/server/openai-proxy/config.ts`
- `OS/apps/frontend/src/server/openai-proxy/upstream.ts`
- control plane config: `/opt/logitaka/data/control-plane/.local/admin/openai-proxy.json`

Preserve existing Cline/Logitaka behavior. `logitaka-default` must keep working.

## Required Public AI Aliases

Extend the existing OpenAI-compatible proxy to support several public model aliases:

- `logitaka-default`
- `phi-parser`
- `phi-classifier`
- `phi-vision`

`GET /v1/models` must return all enabled public aliases.

`POST /v1/chat/completions` must accept `payload.model` matching one of these aliases and resolve it to an internal model/agent/fallback route.

Backward compatibility requirement:

- If the new alias config is absent, the old config shape with `public_model_id` and `current_model_key` must behave exactly as before.

Suggested backward-compatible config extension:

```json
{
  "schema_version": 1,
  "enabled": true,
  "public_model_id": "logitaka-default",
  "current_model_key": "openrouter_claude_opus",
  "model_aliases": {
    "logitaka-default": {
      "current_model_key": "openrouter_claude_opus"
    },
    "phi-parser": {
      "current_model_key": "openai_gpt54_mini"
    },
    "phi-classifier": {
      "current_model_key": "alibaba_qwen_flash"
    },
    "phi-vision": {
      "current_model_key": "openai_gpt54_nano"
    }
  },
  "clients": []
}
```

Fallback chains are desirable, but not required for the first safe implementation. If fallback chains are added, keep the config readable and preserve single-target aliases.

## Required PHI Tool Endpoints

Add PHI-specific endpoints outside `/v1` so PHI can call stable task endpoints without knowing Logitaka internals.

Recommended namespace:

- `POST /phi/ekassa/receipt-image`
- `POST /phi/receipt/analyze`
- `POST /phi/voice/parse`
- `POST /phi/items/classify`

If implementation time is limited, prioritize:

1. `POST /phi/ekassa/receipt-image`
2. `POST /phi/receipt/analyze`
3. `phi-parser`, `phi-classifier`, `phi-vision` aliases under `/v1/chat/completions`

## Authentication

Use bearer auth.

Either reuse the existing OpenAI proxy client mechanism or add a PHI-specific auth helper using the same stored hash style.

Create a dedicated client:

- client id: `phi-backend`
- label: `PHI Backend`
- enabled: true

Do not store plaintext PHI secrets in repo.
Do not commit secrets.
If a new PHI bearer key is generated, print it once for the operator, store only its hash in the control plane config, and document only the key hint.

Every PHI endpoint must require:

```text
Authorization: Bearer <PHI_GATEWAY_TOKEN>
```

Return `401` for missing/invalid token.
Return `503` if the gateway/proxy is disabled.

## e-Kassa Receipt Image Endpoint

Endpoint:

```text
POST /phi/ekassa/receipt-image
```

Request:

```json
{
  "qr_url": "https://monitoring.e-kassa.gov.az/#/index?doc=...",
  "fiscal_id": "optional raw fiscal id"
}
```

At least one of `qr_url` or `fiscal_id` is required.

Fiscal ID extraction rules:

```text
doc=([A-HJ-NP-Za-km-z1-9]{42,46})
^[A-HJ-NP-Za-km-z1-9]{42,46}$
```

Download URL:

```text
https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/{FISCAL_ID}
```

Valid download statuses:

- `200`: OK
- `206`: duplicate/partial but image body is usable

Known failure:

- `209`: receipt not found

Success response:

```json
{
  "success": true,
  "data": {
    "fiscal_id": "...",
    "image_base64": "...",
    "mime_type": "image/jpeg",
    "source_http_status": 200
  }
}
```

Failure response:

```json
{
  "success": false,
  "error": {
    "code": "ekassa_receipt_not_found",
    "message": "Receipt was not found in e-Kassa."
  }
}
```

Expected error codes:

- `invalid_request`
- `invalid_fiscal_id`
- `ekassa_download_failed`
- `ekassa_receipt_not_found`
- `ekassa_empty_response`
- `gateway_timeout`

## Receipt Analyze Endpoint

Endpoint:

```text
POST /phi/receipt/analyze
```

Purpose:

Accept QR data or an uploaded/base64 receipt image, perform external processing, and return a PHI-ready receipt JSON object. Do not store anything.

Request variants:

QR:

```json
{
  "source": "qr",
  "qr_url": "...",
  "fiscal_id": "... optional ...",
  "categories": [
    {
      "id": "category uuid",
      "name": "Food"
    }
  ],
  "category_rules": [
    {
      "pattern": "normalized item name",
      "category_id": "category uuid"
    }
  ]
}
```

Image:

```json
{
  "source": "image",
  "image_base64": "...",
  "mime_type": "image/jpeg",
  "categories": [],
  "category_rules": []
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "merchant": "Store name",
    "date": "2026-05-15 17:38:01",
    "total": 4.16,
    "currency": "AZN",
    "payment_method": "cash",
    "ocr_text": "optional OCR text",
    "items": [
      {
        "raw_name": "FULL COLA 2 L PET",
        "normalized_name": "full cola 2 l pet",
        "quantity": 1,
        "unit_price": 1.5,
        "line_total": 1.5,
        "category_id": "category uuid or null",
        "confidence": 0.8
      }
    ],
    "diagnostics": {
      "image_source": "ekassa",
      "ocr_used": true,
      "regex_parser_used": true,
      "ai_parser_used": false,
      "classifier_used": true,
      "model": "phi-parser"
    }
  }
}
```

Rules:

- Return major units for money, for example `4.16`, not minor units.
- PHI backend will convert to minor units.
- Do not invent category IDs. Use only IDs provided in `categories`.
- If no category fits, return `null`.
- Include all purchased receipt items, including non-food/non-finance-looking items.
- Do not save anything.

Suggested pipeline:

1. If source is QR, download e-Kassa image.
2. OCR the image.
3. Try deterministic e-Kassa parser when OCR text is standard enough.
4. If deterministic parser fails, call `phi-parser`.
5. Classify items using rules first.
6. For remaining items, call `phi-classifier`.
7. Return normalized receipt JSON.

## Voice Parse Endpoint

Endpoint:

```text
POST /phi/voice/parse
```

Purpose:

Accept audio or text from PHI, parse expenses, classify into provided PHI categories, and return pending-operation candidates. Do not store anything.

Request:

```json
{
  "input_type": "audio",
  "audio_base64": "...",
  "mime_type": "audio/webm",
  "text": "optional text if input_type is text",
  "categories": [
    {
      "id": "category uuid",
      "name": "Taxi"
    }
  ]
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "merchant": "Yango",
        "category_id": "category uuid or null",
        "amount_minor": 550,
        "description": "taxi",
        "confidence": 0.85
      }
    ],
    "diagnostics": {
      "transcription_used": true,
      "model": "phi-parser"
    }
  }
}
```

Rules:

- For voice/text operations, return `amount_minor` as integer minor units because PHI's current pending operation flow already expects that.
- Use only provided category IDs.
- Return `null` category if uncertain.
- Do not save anything.

## Item Classify Endpoint

Endpoint:

```text
POST /phi/items/classify
```

Request:

```json
{
  "items": [
    "full cola 2 l pet",
    "bazarstore market torbasi"
  ],
  "categories": [
    {
      "id": "category uuid",
      "name": "Food"
    }
  ]
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "map": {
      "full cola 2 l pet": "category uuid",
      "bazarstore market torbasi": null
    },
    "diagnostics": {
      "model": "phi-classifier"
    }
  }
}
```

## Error Response Standard

All PHI endpoints should return:

```json
{
  "success": false,
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable message.",
    "details": {}
  }
}
```

Use appropriate HTTP statuses:

- `400`: invalid request / invalid input.
- `401`: missing or invalid bearer token.
- `403`: disabled client or forbidden.
- `408` or `504`: timeout.
- `502`: upstream provider/e-Kassa/OCR failed.
- `503`: gateway disabled or no model configured.

## Logging

Log enough for debugging:

- request id
- endpoint
- PHI client id
- task type
- selected alias/model
- fallback attempts
- upstream HTTP status
- duration
- error code

Never log:

- bearer tokens
- provider API keys
- full base64 images/audio by default
- full PHI user payloads with sensitive notes unless explicitly in debug mode

## Validation And Safety

Validate payload size.

Suggested limits:

- image base64: 15 MB decoded max
- audio base64: 25 MB decoded max
- OCR text: 100 KB max

Set timeouts:

- e-Kassa download: 15 seconds
- OCR: 30-45 seconds
- AI parser/classifier: 45 seconds per attempt
- whole receipt analyze: 90 seconds max

Return clear timeout errors instead of hanging.

## Tests / Manual Verification

After implementation, verify:

1. Existing Cline route still works:

```text
GET /v1/models
POST /v1/chat/completions model=logitaka-default
```

2. PHI aliases work:

```text
POST /v1/chat/completions model=phi-parser
POST /v1/chat/completions model=phi-classifier
POST /v1/chat/completions model=phi-vision
```

3. e-Kassa image endpoint:

```text
POST /phi/ekassa/receipt-image
```

with a valid test QR/fiscal ID.

4. Receipt analyze endpoint:

```text
POST /phi/receipt/analyze
```

with QR and image variants if possible.

5. Invalid token returns `401`.
6. Invalid fiscal ID returns `400`.
7. Provider timeout/failure returns structured `502` or `504`.

## Deliverables Back To PHI

When done, report:

- Deployed base URL.
- List of `/v1` public model aliases.
- PHI endpoint paths.
- PHI bearer key or instructions for generating/rotating it.
- Whether fallback chains are implemented or only single target aliases.
- Any model keys chosen for `phi-parser`, `phi-classifier`, and `phi-vision`.
- Any known limitations.

## Do Not Do

- Do not modify PHI backend from inside the Logitaka/VPS task.
- Do not change PHI DB schema.
- Do not store PHI receipts or operations on VPS.
- Do not remove or break `logitaka-default`.
- Do not expose provider keys to PHI frontend.
- Do not commit plaintext secrets.
- Do not redesign Logitaka AI runtime beyond what is needed for these endpoints.
