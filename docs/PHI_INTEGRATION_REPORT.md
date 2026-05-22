# Технический отчет по интеграции с PHI Gateway

## 1. Общие сведения
Для обхода сетевых ограничений бэкенда PHI на внешние вызовы (в т.ч. к AI-провайдерам и e-Kassa) был развернут выделенный шлюз **PHI Gateway**.
* **Базовый URL шлюза**: `https://gateway.phi.nagiyev.com`
* **Публичный IP-адрес шлюза** (для добавления в allowlist на стороне хостинга PHI): `188.245.144.148`
* **Авторизация**: Все запросы к шлюзу (кроме `/health`) требуют заголовок:
  ```http
  Authorization: Bearer phi_64fe87176a8093cb83979b56a0b29eca9c477219627e18c10f12efc8d747a7fe
  ```

---

## 2. Публичные алиасы моделей (OpenAI-compatible)
При отправке запросов на чат-комплишены (`POST /v1/chat/completions`) бэкенд PHI должен использовать следующие публичные алиасы в поле `"model"`:
1. **`phi-parser`** — разбор финансовых транзакций и вычленение деталей.
2. **`phi-classifier`** — классификация товаров по категориям.
3. **`phi-vision`** — распознавание и парсинг изображений чеков.
4. **`phi-audio-transcriber`** — точное транскрибирование аудиозаписей.

> [!NOTE]
> **Каскадные фолбеки (Fallback Chains)**: Шлюз автоматически перенаправляет запросы по цепочке альтернативных провайдеров в случае сбоя основной модели.
> Например, для `phi-classifier` цепочка выглядит так:
> `deepseek/deepseek-v4-flash:free` (OpenRouter) ➔ `mistral-small-latest` (Mistral) ➔ `gpt-5.4-nano` (OpenAI) ➔ `glm-4.7-flash` (Z.AI) ➔ `qwen-flash` (Alibaba).
> В ответе шлюза всегда возвращается исходный алиас модели (например, `"model": "phi-classifier"`), скрывая внутренние ключи провайдеров.

---

## 3. Спецификация API-эндпоинтов для интеграции в PHI

### 3.1. Проверка работоспособности
* **Эндпоинт**: `GET /health`
* **Авторизация**: Не требуется
* **Ответ (200 OK)**:
  ```json
  { "ok": true, "service": "phi-gateway" }
  ```

### 3.2. Чат-комплишены (OpenAI-compatible)
* **Эндпоинт**: `POST /v1/chat/completions`
* **Тело запроса**:
  ```json
  {
    "model": "phi-classifier",
    "messages": [
      { "role": "user", "content": "Классифицируй товар: Хлеб Бородинский" }
    ],
    "temperature": 0
  }
  ```

### 3.3. Загрузка изображения чека из e-Kassa
* **Эндпоинт**: `POST /phi/ekassa/receipt-image`
* **Тело запроса** (требуется хотя бы одно поле):
  ```json
  {
    "qr_url": "https://monitoring.e-kassa.gov.az/#/index?doc=...", // опционально
    "fiscal_id": "raw fiscal id string" // опционально
  }
  ```
* **Ответ (200 OK)**:
  ```json
  {
    "success": true,
    "data": {
      "fiscal_id": "...",
      "image_base64": "...", // jpeg изображение в base64
      "mime_type": "image/jpeg",
      "source_http_status": 200
    }
  }
  ```
* **Типовые ошибки**:
  * `400 / invalid_fiscal_id` — некорректный формат фискального ID.
  * `502 / ekassa_receipt_not_found` — чек еще не загружен в базу e-Kassa (код ответа e-Kassa: 209).

### 3.4. Комплексный анализ чека (Vision OCR + классификация)
* **Эндпоинт**: `POST /phi/receipt/analyze`
* **Тело запроса**:
  ```json
  {
    "source": "qr", // или "image"
    "qr_url": "https://...", // если source = "qr"
    "fiscal_id": "...", // если source = "qr" (опционально)
    "image_base64": "...", // если source = "image"
    "mime_type": "image/jpeg", // если source = "image"
    "categories": [
      { "id": "uuid-1", "name": "Продукты" },
      { "id": "uuid-2", "name": "Развлечения" }
    ],
    "category_rules": [
      { "pattern": "cola", "category_id": "uuid-1" }
    ]
  }
  ```
* **Поведение шлюза**:
  1. Если `source === 'qr'`, шлюз сам скачивает чек из e-Kassa.
  2. Распознает чек через `phi-vision`.
  3. Маппит товары по регулярным выражениям из `category_rules`.
  4. Оставшиеся нераспознанные товары пачкой отправляет на классификацию в `phi-classifier`.
* **Ответ (200 OK)**:
  * **Примечание**: Все цены и суммы возвращаются в **основных единицах** (float, например `4.16` AZN), PHI конвертирует их в минорные копейки самостоятельно.
  ```json
  {
    "success": true,
    "data": {
      "merchant": "Bazarstore",
      "date": "2026-05-15 17:38:01",
      "total": 4.16,
      "currency": "AZN",
      "payment_method": "card", // "cash" или "card"
      "items": [
        {
          "raw_name": "COLA 2L",
          "normalized_name": "cola 2l",
          "quantity": 1,
          "unit_price": 1.5,
          "line_total": 1.5,
          "category_id": "uuid-1",
          "confidence": 0.8
        }
      ],
      "diagnostics": {
        "image_source": "ekassa",
        "ocr_used": true,
        "regex_parser_used": true,
        "ai_parser_used": true,
        "classifier_used": true,
        "model": "phi-parser"
      }
    }
  }
  ```

### 3.5. Парсинг голосовых и текстовых транзакций
* **Эндпоинт**: `POST /phi/voice/parse`
* **Тело запроса**:
  ```json
  {
    "input_type": "audio", // или "text"
    "audio_base64": "...", // если input_type = "audio"
    "mime_type": "audio/webm", // если input_type = "audio" (по умолчанию audio/webm)
    "text": "optional text if input_type is text",
    "categories": [
      { "id": "uuid-taxi", "name": "Такси" }
    ]
  }
  ```
* **Поведение шлюза**:
  1. Если `input_type === 'audio'`, шлюз транскрибирует аудио через `phi-audio-transcriber`.
  2. Вычленяет мерчанта, сумму и категорию при помощи `phi-parser`.
* **Ответ (200 OK)**:
  * **Примечание**: Возвращает `amount_minor` (в **минорных** единицах, например `5.50` AZN ➔ `550`), так как бэкенд PHI исторически ожидает этот формат для быстрых транзакций.
  ```json
  {
    "success": true,
    "data": {
      "items": [
        {
          "merchant": "Yango",
          "category_id": "uuid-taxi",
          "amount_minor": 550,
          "description": "Поездка на такси",
          "confidence": 0.85
        }
      ],
      "diagnostics": {
        "transcription_used": true,
        "model": "phi-parser",
        "raw_transcript": "Такси пять манат пятьдесят гяпик"
      }
    }
  }
  ```

### 3.6. Пакетная классификация списка товаров
* **Эндпоинт**: `POST /phi/items/classify`
* **Тело запроса**:
  ```json
  {
    "items": [
      "full cola 2 l pet",
      "market torbasi"
    ],
    "categories": [
      { "id": "uuid-1", "name": "Продукты" }
    ]
  }
  ```
* **Ответ (200 OK)**:
  ```json
  {
    "success": true,
    "data": {
      "map": {
        "full cola 2 l pet": "uuid-1",
        "market torbasi": null
      },
      "diagnostics": {
        "model": "phi-classifier"
      }
    }
  }
  ```

---

## 4. Стандарт ошибок
В случае сбоя или некорректного запроса эндпоинты возвращают структурированную ошибку:
```json
{
  "success": false,
  "error": {
    "code": "machine_readable_code",
    "message": "Human-readable description.",
    "details": {} // дополнительный контекст
  }
}
```
**Коды ошибок для обработки**:
* `invalid_request` (HTTP 400) — невалидные поля тела запроса.
* `forbidden` (HTTP 403) — токен не имеет прав на вызов данной модели/эндпоинта.
* `gateway_timeout` (HTTP 504) — таймаут ожидания провайдера или e-Kassa.
* `ekassa_receipt_not_found` (HTTP 502) — чека нет в базе налоговой (стоит повторить запрос позже).
* `fallback_chain_failed` (HTTP 502) — все модели в цепочке каскада вернули ошибку.
