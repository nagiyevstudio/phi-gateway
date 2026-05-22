# Secret Setup Checklist

The future gateway implementation should need only these user-supplied secrets.

## PHI Client Key

Generate one strong bearer key for PHI shared hosting:

```text
PHI_GATEWAY_API_KEY=<generated-once>
```

Store only:

- `key_hash`
- `key_hint`

Do not store the raw key after giving it to the user.

## Provider Keys

Fill only the providers that will be enabled:

```text
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
DASHSCOPE_API_KEY=...
ZAI_API_KEY=...
```

These should live in `/opt/phi-gateway/config/phi-gateway.env` or another root-protected secret file on the VPS, not in git.

## Current Minimal Recommendation

For first implementation, one provider key can be enough:

- OpenRouter for `phi-parser`, `phi-classifier`, and `phi-vision`.

For audio transcription, add one of:

- Gemini API key, preferred for `google_gemini_flash_lite` style audio understanding.
- OpenAI API key for `gpt-4o-transcribe` style request-based transcription.

