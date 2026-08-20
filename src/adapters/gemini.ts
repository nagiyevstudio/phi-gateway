import { OpenAICompletionRequest, OpenAICompletionResponse, ChatMessage, ChatMessagePart } from './types';

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: { text: string }[];
  };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: 'application/json' | 'text/plain';
  };
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
      role?: string;
    };
    finishReason?: string;
    index?: number;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export function mapOpenAIToGemini(request: OpenAICompletionRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let systemInstructions: string[] = [];

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      const contentText = typeof msg.content === 'string' 
        ? msg.content 
        : msg.content.map(p => p.type === 'text' ? p.text || '' : '').join('\n');
      if (contentText.trim()) {
        systemInstructions.push(contentText);
      }
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else {
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          parts.push({ text: part.text });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url;
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mimeType, data] = match;
            parts.push({
              inlineData: {
                mimeType,
                data
              }
            });
          } else {
            console.warn('[Gemini Adapter] External image URLs not supported natively by inline data, skipping or needs downloading.');
          }
        } else if (part.type === 'input_audio' && part.input_audio?.data) {
          const formatToMime: Record<string, string> = {
            'wav': 'audio/wav',
            'mp3': 'audio/mp3',
            'webm': 'audio/webm',
            'ogg': 'audio/ogg',
            'flac': 'audio/flac',
            'm4a': 'audio/mp4'
          };
          const mimeType = formatToMime[part.input_audio.format] || `audio/${part.input_audio.format}`;
          parts.push({
            inlineData: {
              mimeType,
              data: part.input_audio.data
            }
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  const geminiReq: GeminiRequest = { contents };

  if (systemInstructions.length > 0) {
    geminiReq.systemInstruction = {
      parts: [{ text: systemInstructions.join('\n\n') }]
    };
  }

  const generationConfig: any = {};
  if (typeof request.temperature === 'number') {
    generationConfig.temperature = request.temperature;
  }
  if (typeof request.max_tokens === 'number') {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (request.response_format?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiReq.generationConfig = generationConfig;
  }

  return geminiReq;
}

export function mapGeminiToOpenAI(
  geminiRes: GeminiResponse, 
  originalModelAlias: string
): OpenAICompletionResponse {
  const candidate = geminiRes.candidates?.[0];
  const responseText = candidate?.content?.parts?.map(p => p.text || '').join('') || '';

  // Map Gemini finish reasons to OpenAI compatible ones
  let finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null = 'stop';
  const geminiReason = candidate?.finishReason;
  if (geminiReason === 'MAX_TOKENS') {
    finishReason = 'length';
  } else if (geminiReason === 'SAFETY' || geminiReason === 'RECITATION') {
    finishReason = 'content_filter';
  }

  return {
    id: `chatcmpl-gemini-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModelAlias,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: responseText
        },
        finish_reason: finishReason
      }
    ],
    usage: geminiRes.usageMetadata ? {
      prompt_tokens: geminiRes.usageMetadata.promptTokenCount || 0,
      completion_tokens: geminiRes.usageMetadata.candidatesTokenCount || 0,
      total_tokens: geminiRes.usageMetadata.totalTokenCount || 0
    } : undefined
  }
}

export async function callGemini(
  apiModelId: string,
  apiKey: string,
  baseUrl: string,
  payload: OpenAICompletionRequest,
  originalModelAlias: string,
  timeoutMs: number = 60000
): Promise<OpenAICompletionResponse> {
  const geminiPayload = mapOpenAIToGemini(payload);
  const url = `${baseUrl.replace(/\/+$/, '')}/models/${apiModelId}:generateContent`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(geminiPayload),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API returned status ${response.status}: ${errorText}`);
    }

    const responseData = await response.json() as GeminiResponse;
    return mapGeminiToOpenAI(responseData, originalModelAlias);
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}
