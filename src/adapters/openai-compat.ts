import { OpenAICompletionRequest, OpenAICompletionResponse } from './types';

export async function callOpenAICompat(
  apiModelId: string,
  apiKey: string,
  baseUrl: string,
  payload: OpenAICompletionRequest,
  originalModelAlias: string,
  timeoutMs: number = 60000
): Promise<OpenAICompletionResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // Clone payload and override the model with the upstream api_model_id
  const clonedPayload = {
    ...payload,
    model: apiModelId
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };

  // OpenRouter specific headers for analytics, if configured
  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://gateway.phi.nagiyev.com';
    headers['X-Title'] = 'PHI Gateway';
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(clonedPayload),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upstream API returned status ${response.status}: ${errorText}`);
    }

    const responseData = await response.json() as OpenAICompletionResponse;
    
    // Override the model in the response to show the public model alias instead of the upstream api_model_id
    if (responseData && responseData.model) {
      responseData.model = originalModelAlias;
    }
    
    return responseData;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}
