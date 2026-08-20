export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessagePart[];
  name?: string;
}

export interface ChatMessagePart {
  type: 'text' | 'image_url' | 'input_audio';
  text?: string;
  image_url?: {
    url: string; // can be base64 data URL
    detail?: 'low' | 'high' | 'auto';
  };
  input_audio?: {
    data: string; // base64
    format: string; // 'wav' | 'mp3' | 'webm' | 'ogg' | 'flac' | 'm4a'
  };
}

export interface OpenAICompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: {
    type: 'json_object';
    schema?: Record<string, any>;
  };
}

export interface OpenAICompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
