# Sanitized Model Inventory From Logitaka

Source: live VPS control-plane config read in read-only mode. API keys were not printed or copied.

Use this as orientation only. The PHI gateway should have its own provider config and keys.

| Key | Label | Provider | API model id | Status | Class | Capabilities | Internal cost in/out per 1M |
|---|---|---|---|---|---|---|---|
| `openrouter_claude_opus` | Claude Opus 4.7* | openrouter | `anthropic/claude-opus-4.7` | active | C4 | text, image, pdf, structured, tools, reasoning | 10 / 50 |
| `openrouter_claude_sonnet` | Claude Sonnet 4.6* | openrouter | `anthropic/claude-sonnet-4.6` | active | C3 | text, image, pdf, structured, tools, reasoning | 6 / 30 |
| `openrouter_qwen_reasoning` | Qwen 3.6 Plus* | openrouter | `qwen/qwen3.6-plus` | active | C4 | text, image, pdf, structured, tools, reasoning | 0.6 / 4 |
| `openrouter_qwen_max` | Qwen 3.6 Max* | openrouter | `qwen/qwen3.6-max-preview` | active | C4 | text, image, pdf, structured, tools, reasoning | 2 / 12 |
| `openrouter_gemini_pro` | Gemini 3.1 Pro* | openrouter | `google/gemini-3.1-pro-preview` | active | C3 | text, image, pdf, structured, tools, reasoning | 4 / 24 |
| `google_gemini_flash_lite` | Gemini 3.1 Flash Lite | google | `gemini-3.1-flash-lite` | active | C1 | text, image, audio, pdf, transcription, structured, fast | 0.5 / 3 |
| `google_gemini_flash` | Gemini 3 Flash | google | `gemini-3-flash-preview` | active | C2 | text, image, audio, pdf, structured, tools, fast | 1 / 6 |
| `gemini_flash_latest` | Gemini 3.5 Flash | google | `gemini-3.5-flash` | active | C3 | text, image, audio, pdf, structured, tools, reasoning, fast | 3 / 18 |
| `openai_gpt54_nano` | GPT-5.4 nano | openai | `gpt-5.4-nano` | active | C1 | text, image, structured, fast | 0.4 / 2.5 |
| `openai_gpt54_mini` | GPT-5.4 mini | openai | `gpt-5.4-mini` | active | C2 | text, structured, tools, fast | 1.5 / 9 |
| `openai_gpt5` | GPT-5.4 | openai | `gpt-5.4` | active | C3 | text, structured, reasoning | 5 / 30 |
| `openai_gpt4o_transcribe` | Transcribe model | openai | `gpt-4o-transcribe` | active | n/a | audio transcription model in Logitaka config | 5 / 20 |
| `alibaba_qwen_flash` | Qwen 3.6 Flash | alibaba | `qwen3.6-flash` | active | C1 | text, image, structured, tools, reasoning, fast | 0.4 / 2.5 |
| `zai_glm51` | GLM-5.1 | zai | `glm-5.1` | active | C3 | text, structured, reasoning | 2 / 6.4 |
| `zai_free` | GLM-4.7 Flash | zai | `glm-4.7-flash` | active | C2 | text, structured, reasoning, fast | 0.4 / 1 |
| `moonshot_kimi` | Kimi K2.6 | moonshot | `kimi-k2.6` | active | C3 | text, image, structured, tools, reasoning | 1.8 / 8 |

## Suggested PHI Alias Defaults

These are starting guesses, not final commitments.

| Alias | First target | Fallbacks | Why |
|---|---|---|---|
| `phi-parser` | `openrouter_qwen_reasoning` | `openrouter_claude_sonnet`, `zai_glm51` | structured extraction with good cost/performance |
| `phi-classifier` | `openai_gpt54_nano` | `zai_free`, `alibaba_qwen_flash` | cheap, fast routing/classification |
| `phi-vision` | `openrouter_qwen_reasoning` | `openrouter_claude_sonnet`, `moonshot_kimi` | image-capable structured parsing |
| `phi-audio-transcriber` | `google_gemini_flash_lite` | `gemini_flash_latest`, `openai_gpt4o_transcribe` | direct audio/transcription capability |

## External Provider Notes

- Gemini audio understanding supports audio input and text output for transcription/summarization style tasks.
- Gemini API is not the right choice for realtime transcription; use Live API or a dedicated speech-to-text path for live audio.
- Qwen-Omni supports audio input/output through Alibaba's OpenAI-compatible endpoint, but the docs indicate streaming is required for those requests.
- OpenAI supports request-based audio APIs, realtime sessions, and multimodal chat completions for audio-capable models.

Useful docs:

- Google Gemini audio: `https://ai.google.dev/gemini-api/docs/audio`
- Google Gemini models: `https://ai.google.dev/gemini-api/docs/models`
- Alibaba Qwen-Omni: `https://www.alibabacloud.com/help/en/model-studio/qwen-omni`
- Alibaba model overview: `https://www.alibabacloud.com/help/en/model-studio/models`
- OpenAI audio guide: `https://developers.openai.com/api/docs/guides/audio`

