import { getModelAliases } from '../config';

const PORT = 3200;
const BASE_URL = `http://localhost:${PORT}`;
const VALID_TOKEN = 'phi_ad184700ce0fde87031273db50eb9926fcebbcd3c131f43af00fd9e9548fa8fc';

async function runTests() {
  console.log('=== STARTING PHI GATEWAY INTEGRATION TESTS ===\n');

  // Test 1: Health
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const json = await res.json();
    console.log('✅ Health check:', res.status, json);
  } catch (err) {
    console.error('❌ Health check failed:', err);
  }

  // Test 2: Invalid Auth
  try {
    const res = await fetch(`${BASE_URL}/auth-test`, {
      headers: { 'Authorization': 'Bearer bad_token' }
    });
    const json = await res.json();
    console.log('✅ Auth check (invalid):', res.status === 401 ? 'PASS (401)' : 'FAIL', json);
  } catch (err) {
    console.error('❌ Auth check (invalid) failed:', err);
  }

  // Test 3: Valid Auth
  try {
    const res = await fetch(`${BASE_URL}/auth-test`, {
      headers: { 'Authorization': `Bearer ${VALID_TOKEN}` }
    });
    const json = await res.json();
    console.log('✅ Auth check (valid):', res.status === 200 ? 'PASS (200)' : 'FAIL', json);
  } catch (err) {
    console.error('❌ Auth check (valid) failed:', err);
  }

  // Test 4: Models List
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${VALID_TOKEN}` }
    });
    const json = await res.json();
    console.log('✅ Models List:', res.status, json.data ? `${json.data.length} models returned` : 'No data');
  } catch (err) {
    console.error('❌ Models List failed:', err);
  }

  // Test 5: e-Kassa Downloader (receipt not found check)
  try {
    const res = await fetch(`${BASE_URL}/phi/ekassa/receipt-image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fiscal_id: 'A2C4E6G8J1K3M5N7P9Q2R4S6T8U1V3W5X7Y9Z2a4b6c8d'
      })
    });
    const json = await res.json();
    console.log('✅ e-Kassa download (not found):', res.status === 502 ? 'PASS (502 Not Found)' : 'FAIL', json);
  } catch (err) {
    console.error('❌ e-Kassa download failed:', err);
  }

  // Test 6: Item Classifier (fallback failure diagnostic check)
  try {
    const res = await fetch(`${BASE_URL}/phi/items/classify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        items: ['Coca-Cola 1L', 'Bravo torba'],
        categories: [{ id: 'cat-food', name: 'Food' }]
      })
    });
    const json = await res.json();
    console.log('✅ Item Classifier:', res.status, JSON.stringify(json).slice(0, 200) + '...');
  } catch (err) {
    console.error('❌ Item Classifier failed:', err);
  }

  // Test 7: Receipt Analyze (Image source, model routing check)
  try {
    const res = await fetch(`${BASE_URL}/phi/receipt/analyze`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source: 'image',
        image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', // 1x1 transparent png
        categories: [{ id: 'cat-groceries', name: 'Groceries' }],
        category_rules: [{ pattern: 'cola', category_id: 'cat-groceries' }]
      })
    });
    const json = await res.json();
    console.log('✅ Receipt Analyze:', res.status, JSON.stringify(json).slice(0, 200) + '...');
  } catch (err) {
    console.error('❌ Receipt Analyze failed:', err);
  }

  // Test 8: Voice Parse (Text input, parser routing check)
  try {
    const res = await fetch(`${BASE_URL}/phi/voice/parse`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        input_type: 'text',
        text: 'Spent 5 AZN on Cola and 10 AZN on taxi.',
        categories: [
          { id: 'cat-groceries', name: 'Groceries' },
          { id: 'cat-transport', name: 'Transport' }
        ]
      })
    });
    const json = await res.json();
    console.log('✅ Voice Parse (text):', res.status, JSON.stringify(json).slice(0, 200) + '...');
  } catch (err) {
    console.error('❌ Voice Parse failed:', err);
  }

  console.log('\n=== INTEGRATION TESTS COMPLETED ===');
}

runTests();
