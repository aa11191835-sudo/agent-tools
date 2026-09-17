/**
 * 花藝／壽衣款式選擇 + 契約選擇 —— AI 代理（C.ai）工具API
 *
 * 提供給 C.ai 呼叫的工具：
 *   1. GET  /api/catalog?type=flower|shouyi        取得花藝/壽衣款式清單（含圖片網址）
 *   2. GET  /api/image/:type/:id                    取得單一款式圖片
 *   3. POST /api/submit-selection                   確認選擇後寫入 BizForm
 *   4. GET  /api/contract-summary?contract=契約一    取得契約內容摘要，協助C.ai介紹/推薦契約
 *   5. POST /api/customer-tags                       依電話查詢 Vital CRM 客戶標籤，作為推薦依據
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const BIZFORM_BASE = 'https://bizform.vitalyun.com/backend/api';
const API_KEY = process.env.BIZFORM_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://your-app.onrender.com';

// Vital CRM 原生 API（跟 BizForm 是不同系統，用來查詢客戶標籤）
const CRM_STORE_API_BASE = 'https://crm-storeapi.vitalyun.com';
const CRM_STORE_ID = process.env.CRM_STORE_ID || 'faca5f8b5a0b696fa2d5d1cdb1a31185';
const CRM_STORE_APIKEY = process.env.CRM_STORE_APIKEY; // Vital CRM 後台「服務資訊」取得的店點ApiKey

// ========== 讀入資料 ==========
const FLOWER_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'flower-data.json'), 'utf-8'));
const SHOUYI_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'shouyi-data.json'), 'utf-8'));
FLOWER_DATA.forEach((item, i) => (item.id = i));
SHOUYI_DATA.forEach((item, i) => (item.id = i));
const DATASETS = { flower: FLOWER_DATA, shouyi: SHOUYI_DATA };

const CONTRACT_FLEX = {
  '契約一': JSON.parse(fs.readFileSync(path.join(__dirname, 'contract1.json'), 'utf-8')),
  '契約二': JSON.parse(fs.readFileSync(path.join(__dirname, 'contract2.json'), 'utf-8')),
};

const FORM_CONFIGS = {
  flower: {
    formId: 14,
    fieldIds: { custPhone: 'field_1', custName: 'field_2', choice1: 'field_17', choice2: 'field_20', choice3: 'field_18' },
  },
  shouyi: {
    formId: 15,
    fieldIds: { custPhone: 'field_1', custName: 'field_2', choice1: 'field_17', choice2: 'field_24', choice3: 'field_25' },
  },
};

// ========== 小工具 ==========
function parseCustomerInput(input) {
  const trimmed = String(input || '').trim();
  const idx = trimmed.search(/\s+/);
  if (idx === -1) return { name: trimmed, phone: '' };
  return { name: trimmed.slice(0, idx).trim(), phone: trimmed.slice(idx).trim() };
}

function parseContractFlex(flexJson) {
  const result = {};
  const bubbles = flexJson.contents || [];
  bubbles.forEach(bubble => {
    const bodyContents = (bubble.body && bubble.body.contents) || [];
    bodyContents.forEach(item => {
      if (item.type !== 'box' || item.layout !== 'vertical') return;
      const subs = item.contents || [];
      if (subs.length < 2) return;
      const [labelBox, contentBox] = subs;
      let category = null;
      for (const c of (labelBox.contents || [])) {
        if (c.type === 'text' && c.weight === 'bold') { category = c.text; break; }
      }
      if (!category) return;
      const lines = (contentBox.contents || []).filter(c => c.type === 'text').map(c => c.text);
      result[category] = lines.join('\n');
    });
  });
  return result;
}

// ========== 工具1：取得款式清單 ==========
app.get('/api/catalog', (req, res) => {
  const type = req.query.type;
  const dataset = DATASETS[type];
  if (!dataset) return res.status(400).json({ error: '請提供 type 參數：flower 或 shouyi' });

  const list = dataset.map(item => ({
    id: item.id,
    category: item.category || null,
    label: item.label,
    imageUrl: `${PUBLIC_BASE_URL}/api/image/${type}/${item.id}`,
  }));
  res.json({ type, count: list.length, items: list });
});

// ========== 工具2：取得單一款式圖片 ==========
app.get('/api/image/:type/:id', (req, res) => {
  const { type, id } = req.params;
  const dataset = DATASETS[type];
  if (!dataset) return res.status(400).send('type 錯誤');
  const item = dataset[parseInt(id, 10)];
  if (!item) return res.status(404).send('找不到這個款式');

  const match = item.data.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return res.status(500).send('圖片格式錯誤');
  const [, mimeType, base64Content] = match;
  res.set('Content-Type', mimeType);
  res.send(Buffer.from(base64Content, 'base64'));
});

// ========== 工具3：確認選擇後寫入 BizForm ==========
async function createDocument(config, { name, phone, choice1, choice2, choice3 }) {
  const now = new Date().toISOString();
  const { formId, fieldIds } = config;

  const body = {
    id: 0,
    form: { id: formId },
    title: phone,
    summary: name,
    attributes: [
      { id: fieldIds.custPhone, value: [phone] },
      { id: fieldIds.custName, value: [name] },
      { id: fieldIds.choice1, value: [choice1] },
      { id: fieldIds.choice2, value: [choice2] },
      { id: fieldIds.choice3, value: [choice3] },
    ],
    attachments: [],
    categories: [],
    tags: [],
    creationDateTime: now,
    versionCreationDateTime: now,
    permissions: [],
    notificationSetting: { onDocumentCreated: [], onWorkflowCompleted: [] },
    owner: null,
    versionCreator: null,
    versionNumber: 1,
    subDocuments: [],
    state: 0,
    executedDateTime: now,
    lastAuditor: null,
  };

  const res = await fetch(`${BIZFORM_BASE}/Documents`, {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BizForm create failed: ${res.status} ${text}`);
  }
  return res.json();
}

app.post('/api/submit-selection', async (req, res) => {
  try {
    const { type, choice1, choice2, choice3, customer, name, phone } = req.body;
    const config = FORM_CONFIGS[type];
    if (!config) return res.status(400).json({ error: '請提供 type 參數：flower 或 shouyi' });
    if (!choice1 || !choice2 || !choice3) {
      return res.status(400).json({ error: '請提供 choice1、choice2、choice3（3款選擇的名稱）' });
    }

    const parsedCustomer = customer ? parseCustomerInput(customer) : { name: name || '', phone: phone || '' };
    if (!parsedCustomer.name || !parsedCustomer.phone) {
      return res.status(400).json({ error: '請提供姓名與電話（例如 customer: "陳大明 0912345678"）' });
    }

    const created = await createDocument(config, { ...parsedCustomer, choice1, choice2, choice3 });
    const documentId = typeof created === 'number' ? created : (created && (created.id ?? created.documentId ?? null));

    res.json({ ok: true, type, choices: [choice1, choice2, choice3], customer: parsedCustomer, documentId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 工具4：契約摘要 ==========
app.get('/api/contract-summary', (req, res) => {
  const contract = req.query.contract;
  if (contract) {
    const flexJson = CONTRACT_FLEX[contract];
    if (!flexJson) return res.status(400).json({ error: `找不到「${contract}」，目前只有「契約一」「契約二」` });
    return res.json({ contract, items: parseContractFlex(flexJson) });
  }
  const all = {};
  Object.keys(CONTRACT_FLEX).forEach(name => {
    all[name] = parseContractFlex(CONTRACT_FLEX[name]);
  });
  res.json({ contracts: all });
});

// ========== 工具5：依電話查詢 Vital CRM 客戶標籤 ==========
app.post('/api/customer-tags', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: '請提供 phone 參數' });

    const crmRes = await fetch(`${CRM_STORE_API_BASE}/${CRM_STORE_ID}/api/customers/search/`, {
      method: 'POST',
      headers: {
        Authorization: `ApiKey ${CRM_STORE_APIKEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ TelecomNum: phone }),
    });

    if (!crmRes.ok) {
      const text = await crmRes.text();
      console.error('CRM 搜尋失敗:', crmRes.status, text);
      return res.status(502).json({ error: 'CRM 查詢失敗，請稍後再試' });
    }

    const result = await crmRes.json();
    const customer = (result.data || [])[0];

    if (!customer) {
      return res.json({ found: false, phone, labels: [] });
    }

    // Labels 格式為分號分隔的字串，例如「重視地方特有風俗;注重科儀」
    const labels = (customer.Labels || '').split(';').map(s => s.trim()).filter(Boolean);

    res.json({
      found: true,
      phone,
      name: customer.CurrentName,
      customerId: customer.CustomerId,
      labels,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
