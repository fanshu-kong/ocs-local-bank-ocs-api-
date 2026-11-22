/**
 * OCS Local Bank - 本地题库服务
 * 为 OCS 网课助手提供「本地题库优先 + AI 兜底」的搜题接口
 *
 * 仅使用 Node.js 内置模块，零依赖。
 * 启动：node server.mjs  或双击 启动.bat
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const STARTED_AT = Date.now();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BANK_FILE = path.join(DATA_DIR, '题库.json');
const MISS_FILE = path.join(DATA_DIR, '未命中.json');

/* ------------------------------------------------------------------ *
 * 默认配置
 * ------------------------------------------------------------------ */
const DEFAULT_CONFIG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 8899),
  // 题库匹配相似度阈值，0~1，越高越严格
  threshold: 0.6,
  // 服务令牌，填了就要求请求头 X-Token 匹配（局域网共用时建议开启）
  serverToken: '',
  ai: {
    enable: false,
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-5.3-flash',
    fallbackModel: '',
    timeout: 30000,
    // 两次 AI 请求的最小间隔（毫秒），避免触发账户速率限制
    minInterval: 1500,
    // 触发 429/503 时的自动重试次数
    maxRetries: 2,
    // AI 答出的答案自动回写题库
    cacheToBank: true
  }
};

/* ------------------------------------------------------------------ *
 * 预置服务商（供配置页下拉选择）
 * ------------------------------------------------------------------ */
const PROVIDERS = [
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-5.3-flash', note: '按 tokens 计费，通常有赠送额度' },
      { id: 'glm-5.3-flashx', note: '按 tokens 计费' },
      { id: 'glm-4.6', note: '按次计费，额度有限' },
      { id: 'glm-4.5-flash', note: '轻量快速' },
      { id: 'glm-4-flash', note: '轻量快速' }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [{ id: 'deepseek-chat', note: '官方接口，按 tokens 计费' }]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'deepseek/deepseek-chat', note: '部分模型带 :free 后缀可免费' }]
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen2.5:7b', note: '本地运行，无需密钥' }]
  }
];

/* ------------------------------------------------------------------ *
 * 文件读写
 * ------------------------------------------------------------------ */
function readJson(file, fallback) {
  try {
    // 去掉记事本另存为可能产生的 BOM
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** 首次启动时自动生成 config.json / 题库.json */
function ensureFiles() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const example = readJson(path.join(ROOT, 'config.example.json'), null);
    writeJson(CONFIG_FILE, example || DEFAULT_CONFIG);
    console.log('[init] 已生成 config.json，可在 /config 页面完成 AI 配置');
  }
  if (!fs.existsSync(BANK_FILE)) {
    const example = readJson(path.join(ROOT, '题库.example.json'), []);
    writeJson(BANK_FILE, Array.isArray(example) ? example : []);
    console.log('[init] 已生成 题库.json（示例数据，可直接编辑）');
  }
  if (!fs.existsSync(MISS_FILE)) writeJson(MISS_FILE, []);
}

const rawConfig = readJson(CONFIG_FILE, {});
const CONFIG = {
  ...DEFAULT_CONFIG,
  ...rawConfig,
  ai: { ...DEFAULT_CONFIG.ai, ...(rawConfig.ai || {}) }
};

/* ------------------------------------------------------------------ *
 * 题库匹配
 * ------------------------------------------------------------------ */
function loadBank() {
  const data = readJson(BANK_FILE, []);
  if (Array.isArray(data)) return data;
  // 兼容 { "题目": "答案" } 的写法
  return Object.entries(data).map(([question, answer]) => ({ question, answer }));
}

/**
 * 文本归一化：去掉空白、标点、题号、题型前缀与 LaTeX 标记
 * 公式题（如 $\frac{1}{2}$）去掉标记后仍可参与相似度比较
 */
function normalize(input) {
  return String(input ?? '')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：？！“”‘’《》【】（）()\[\]{}<>~`!@#$%^&*_+=|\\\/,.;:?'"-]/g, '')
    .replace(/^(单选题|多选题|判断题|填空题)/, '')
    .replace(/^\d+[、.,．]/, '')
    .toLowerCase();
}

function bigrams(s) {
  const arr = [];
  for (let i = 0; i < s.length - 1; i++) arr.push(s.slice(i, i + 2));
  return arr.length ? arr : [s];
}

/** Sørensen–Dice 相似度，适合中文短文本 */
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  const pool = new Map();
  for (const g of x) pool.set(g, (pool.get(g) || 0) + 1);
  let hit = 0;
  for (const g of y) {
    const n = pool.get(g) || 0;
    if (n > 0) {
      hit++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

function searchBank(title) {
  const target = normalize(title);
  if (!target) return null;
  let best = null;
  for (const item of loadBank()) {
    const q = normalize(item.question);
    if (!q) continue;
    let score = dice(q, target);
    if (q === target) score = 1;
    else if (target.includes(q) || q.includes(target)) score = Math.max(score, 0.86);
    if (!best || score > best.score) best = { item, score };
  }
  const threshold = Number(CONFIG.threshold);
  return best && best.score >= (Number.isFinite(threshold) ? threshold : 0.6) ? best : null;
}

/** 图片字段兼容：数组、单个 url 或 JSON 字符串 */
function normalizeImages(images) {
  if (!images) return [];
  if (Array.isArray(images)) return images.filter(Boolean).map(String);
  if (typeof images === 'string') {
    const trimmed = images.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
      } catch {
        /* 当作普通字符串 */
      }
    }
    return [trimmed];
  }
  return [];
}

/** 记录真正没解决的题（题库与 AI 都没答出来） */
function rememberMiss(payload) {
  const list = readJson(MISS_FILE, []);
  const title = String(payload.title || '').trim();
  if (!title) return;
  const images = normalizeImages(payload.images);
  if (list.some((it) => normalize(it.title) === normalize(title))) return;
  list.push({
    title,
    options: payload.options || '',
    type: payload.type || '',
    images,
    time: new Date().toISOString()
  });
  writeJson(MISS_FILE, list);
}

/** AI 答出的题写回题库，同一题下次直接命中 */
function cacheAiAnswer(question, answer) {
  if (!CONFIG.ai.cacheToBank) return;
  const title = String(question || '').trim();
  const value = String(answer || '').trim();
  if (!title || !value) return;
  try {
    const bank = loadBank();
    if (bank.some((it) => normalize(it.question) === normalize(title))) return;
    // source 用于事后筛出 AI 生成的答案做抽查
    bank.push({ question: title, answer: value, source: 'AI' });
    writeJson(BANK_FILE, bank);
  } catch {
    /* 写库失败不影响本次作答 */
  }
}

/* ------------------------------------------------------------------ *
 * AI 调用
 * ------------------------------------------------------------------ */
const SYSTEM_PROMPT = [
  '你是一个课程题库的答题助手。你的工作是阅读题干与选项，选出正确答案。',
  '输出要求：',
  '1. 只输出一个 JSON 对象，格式为 {"answer":"答案"}，不要输出解释或代码块。',
  '2. 如果题目给了选项字母，答案写字母，例如 "A"；多个正确答案用 # 连接，例如 "A#C"。',
  '3. 判断题答案写成 正确 或 错误；填空题只写填空内容，多个空用 # 连接。',
  '4. 信息不完整时选择最可能的一项，不要留空。'
].join('\n');

/** 降级提示词：主提示词被内容策略拦截时使用 */
const LEAN_PROMPT = '你是答题助手。请只输出 JSON：{"answer":"答案"}，不要输出其他内容。';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 串行闸门：保证两次 AI 请求之间有最小间隔，并遵守限流冷却 */
let aiChain = Promise.resolve();
let lastAiCallAt = 0;
let aiCooldownUntil = 0;

function aiGate() {
  const gap = Math.max(0, Number(CONFIG.ai.minInterval) || 0);
  const run = aiChain.then(async () => {
    const wait = Math.max(gap - (Date.now() - lastAiCallAt), aiCooldownUntil - Date.now());
    if (wait > 0) await sleep(wait);
    lastAiCallAt = Date.now();
  });
  aiChain = run.catch(() => {});
  return run;
}

/** 从模型输出里尽力提取答案（兼容代码块、多余文字、纯字母） */
function extractAnswer(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```[a-zA-Z]*/g, '').trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const value = parsed.answer ?? parsed.答案;
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    } catch {
      /* 继续兜底 */
    }
  }

  const kv = cleaned.match(/"?answer"?\s*[:：]\s*"?([^"\n,}]+)"?/i);
  if (kv && kv[1].trim()) return kv[1].trim();

  const bare = cleaned.replace(/[\s。.！!]/g, '');
  if (/^[A-Ha-h]{1,6}(#[A-Ha-h]+)*$/.test(bare)) return bare.toUpperCase();
  if (cleaned.length <= 60) return cleaned;
  return null;
}

function looksLikeRefusal(text) {
  return /(抱歉|对不起|无法(提供|回答|帮助|确定)|不能(提供|回答|帮助)|不便|建议(你|您)?(咨询|查阅)|涉及(敏感|隐私|版权|违规)|不予(回答|提供))/.test(
    String(text || '')
  );
}

function normalizeAnswer(answer) {
  const value = String(answer)
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s*#\s*/g, '#');
  const plain = value.replace(/\s/g, '');
  if (/^[A-Ha-h#]+$/.test(plain)) return plain.toUpperCase();
  return value;
}

const REASON_MAP = {
  400: '请求参数有误',
  401: '密钥无效',
  402: '账户余额不足',
  403: '无访问权限',
  404: '接口或模型不存在',
  429: '请求频率超限',
  500: '服务异常',
  503: '服务繁忙'
};

async function askAI(payload) {
  const ai = CONFIG.ai;
  if (!ai.enable || !ai.apiKey) return null;

  const images = normalizeImages(payload.images);
  const userPrompt = [
    `【题型】${payload.type || 'unknown'}`,
    `【题干】${payload.suggestion_title || payload.title || ''}`,
    payload.options ? `【选项】\n${payload.options}` : '',
    images.length ? `【提示】本题含 ${images.length} 张图片，无法识别图片内容，请仅依据文字判断。` : ''
  ]
    .filter(Boolean)
    .join('\n');

  async function request(extra, attempt = 0, lean = false, useModel = null) {
    await aiGate();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ai.timeout);

    try {
      const res = await fetch(`${String(ai.baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ai.apiKey}`
        },
        body: JSON.stringify({
          model: useModel || ai.model,
          temperature: 0,
          messages: [
            { role: 'system', content: lean ? LEAN_PROMPT : SYSTEM_PROMPT },
            { role: 'user', content: extra ? `${userPrompt}\n\n${extra}` : userPrompt }
          ]
        })
      });

      if (!res.ok) {
        // 限流：全局冷却后重试
        if ((res.status === 429 || res.status === 503) && attempt < Number(ai.maxRetries ?? 2)) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const backoff = Math.min(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 4000 * (attempt + 1),
            15000
          );
          aiCooldownUntil = Math.max(aiCooldownUntil, Date.now() + backoff);
          return request(extra, attempt + 1, lean, useModel);
        }

        let detail = '';
        try {
          detail = (await res.json())?.error?.message || '';
        } catch {
          /* 忽略解析失败 */
        }

        // 内容策略拦截时换极简提示词再试一次
        if (res.status === 400 && !lean && /(敏感|不安全|内容)/.test(detail)) {
          return request(extra, attempt + 1, true, useModel);
        }

        const reason = REASON_MAP[res.status] || `请求失败(HTTP ${res.status})`;
        return { error: detail ? `${reason}：${detail}` : reason };
      }

      const data = await res.json();
      const message = data?.choices?.[0]?.message || {};
      const answer = extractAnswer(message.content || '');
      if (answer) return { answer };
      return { text: message.content || message.reasoning_content || '' };
    } catch (err) {
      const timedOut = err.name === 'AbortError';
      const fallback = ai.fallbackModel;
      // 主模型超时（推理模型偶发卡死）时切换备用模型
      if (timedOut && fallback && fallback !== (useModel || ai.model) && attempt < 2) {
        return request(extra, attempt + 1, lean, fallback);
      }
      return { error: `请求异常：${timedOut ? '超时' : err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  const first = await request('');
  if (first.answer) return { answer: normalizeAnswer(first.answer) };
  if (first.error) return { error: first.error };

  const retry = await request('请只输出 {"answer":"选项字母或答案"} 格式的 JSON，不要输出其他内容。');
  if (retry.answer) return { answer: normalizeAnswer(retry.answer) };
  if (retry.error) return { error: retry.error };
  if (looksLikeRefusal(retry.text)) return { error: '模型拒绝作答，可尝试更换模型' };
  return { error: '模型未给出可解析的答案' };
}

async function testAiConnection() {
  const ai = CONFIG.ai;
  if (!ai.apiKey) return { ok: false, error: '尚未填写 API Key' };
  const started = Date.now();
  try {
    const res = await fetch(`${String(ai.baseUrl).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0,
        max_tokens: 16,
        messages: [{ role: 'user', content: '只回复 OK' }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      let detail = text.slice(0, 160);
      try {
        detail = JSON.parse(text)?.error?.message || detail;
      } catch {
        /* 保留原文 */
      }
      return { ok: false, ms, error: `HTTP ${res.status}：${detail}` };
    }
    const data = JSON.parse(text);
    return {
      ok: true,
      ms,
      model: data.model || ai.model,
      reply: String(data?.choices?.[0]?.message?.content || '').trim()
    };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { ok: false, ms: Date.now() - started, error: timedOut ? '请求超时' : err.message };
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 工具
 * ------------------------------------------------------------------ */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      out.push(net.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') || ip.startsWith('172.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 生成 OCS 题库配置，url 跟随实际访问地址 */
function buildOcsConfig(origin) {
  return [
    {
      name: '本地题库',
      homepage: origin,
      url: `${origin}/search`,
      method: 'post',
      type: 'GM_xmlhttpRequest',
      contentType: 'json',
      headers: { 'Content-Type': 'application/json' },
      data: {
        title: '${title}',
        options: '${options}',
        type: '${type}',
        images: { handler: 'return (env) => env.images' },
        suggestion_title: { handler: "return (env) => env.suggestion_title || ''" },
        suggestion_options: { handler: "return (env) => env.suggestion_options || ''" }
      },
      handler: "return (res) => res.code === 1 ? [res.data.question, res.data.answer] : [res.msg, undefined]"
    }
  ];
}

/* ------------------------------------------------------------------ *
 * 业务处理
 * ------------------------------------------------------------------ */
async function handleSearch(payload) {
  const title = payload.title || payload.question || '';
  if (!title) return { code: 0, msg: '缺少题目参数 title' };

  const images = normalizeImages(payload.images);
  const candidates = [payload.suggestion_title, title].filter((s) => s && String(s).trim());

  for (const candidate of candidates) {
    const hit = searchBank(candidate);
    if (hit) {
      return {
        code: 1,
        data: {
          question: hit.item.question,
          answer: String(hit.item.answer ?? ''),
          score: Number(hit.score.toFixed(3)),
          source: '题库'
        }
      };
    }
  }

  const aiResult = await askAI({ ...payload, title });
  if (aiResult?.answer) {
    cacheAiAnswer(payload.suggestion_title || title, aiResult.answer);
    return { code: 1, data: { question: title, answer: aiResult.answer, score: 0, source: 'AI' } };
  }

  rememberMiss(payload);

  if (aiResult?.error) return { code: 0, msg: `题库未命中；${aiResult.error}` };
  if (images.length) return { code: 0, msg: `图片题未命中（已记录 ${images.length} 张图片），请手动补充答案` };
  return { code: 0, msg: '题库中未找到该题目（AI 兜底未启用）' };
}

/* ------------------------------------------------------------------ *
 * 配置读写
 * ------------------------------------------------------------------ */
function publicConfig() {
  return {
    enable: CONFIG.ai.enable,
    provider: CONFIG.ai.provider,
    baseUrl: CONFIG.ai.baseUrl,
    model: CONFIG.ai.model,
    fallbackModel: CONFIG.ai.fallbackModel,
    apiKey: maskKey(CONFIG.ai.apiKey),
    timeout: CONFIG.ai.timeout,
    minInterval: CONFIG.ai.minInterval,
    maxRetries: CONFIG.ai.maxRetries,
    cacheToBank: CONFIG.ai.cacheToBank,
    threshold: CONFIG.threshold,
    hasToken: Boolean(CONFIG.serverToken)
  };
}

/** 应用部分更新：只接受白名单字段，写入 config.json 并热更新内存 */
function updateConfig(body) {
  const aiPatch = {};
  if (typeof body.provider === 'string' && body.provider.trim()) aiPatch.provider = body.provider.trim();
  if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) aiPatch.baseUrl = body.baseUrl.trim();
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) aiPatch.apiKey = body.apiKey.trim();
  if (typeof body.model === 'string' && body.model.trim()) aiPatch.model = body.model.trim();
  if (typeof body.fallbackModel === 'string') aiPatch.fallbackModel = body.fallbackModel.trim();
  if (typeof body.enable === 'boolean') aiPatch.enable = body.enable;
  if (typeof body.cacheToBank === 'boolean') aiPatch.cacheToBank = body.cacheToBank;
  if (body.timeout !== undefined && Number(body.timeout) > 0) aiPatch.timeout = Number(body.timeout);
  if (body.minInterval !== undefined && Number(body.minInterval) >= 0) aiPatch.minInterval = Number(body.minInterval);
  if (body.maxRetries !== undefined && Number(body.maxRetries) >= 0) aiPatch.maxRetries = Number(body.maxRetries);

  const rootPatch = {};
  if (body.threshold !== undefined && Number(body.threshold) > 0 && Number(body.threshold) <= 1) {
    rootPatch.threshold = Number(body.threshold);
  }
  if (typeof body.serverToken === 'string') rootPatch.serverToken = body.serverToken.trim();

  if (!Object.keys(aiPatch).length && !Object.keys(rootPatch).length) return null;

  const raw = readJson(CONFIG_FILE, {});
  const next = { ...raw, ...rootPatch };
  next.ai = { ...CONFIG.ai, ...(raw.ai || {}), ...aiPatch };
  if (next.host === undefined) next.host = CONFIG.host;
  if (next.port === undefined) next.port = CONFIG.port;
  if (next.threshold === undefined) next.threshold = CONFIG.threshold;

  writeJson(CONFIG_FILE, next);

  Object.assign(CONFIG, rootPatch);
  CONFIG.ai = { ...CONFIG.ai, ...aiPatch };

  return publicConfig();
}

/* ------------------------------------------------------------------ *
 * 静态页面
 * ------------------------------------------------------------------ */
function serveConfigPage(res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  try {
    const html = fs.readFileSync(file, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('缺少 public/index.html，请确认仓库文件完整');
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const origin = `http://${req.headers.host || `127.0.0.1:${CONFIG.port}`}`;

  if (req.method === 'OPTIONS') return send(res, 200, { code: 1 });

  /* ---------- 公开接口 ---------- */
  if (route === '/' || route === '/health') {
    return send(res, 200, {
      code: 1,
      msg: 'OCS 本地题库服务运行中',
      version: VERSION,
      bankSize: loadBank().length,
      ai: CONFIG.ai.enable && CONFIG.ai.apiKey ? '已启用' : '未启用',
      ocsConfig: `${origin}/ocs-config`
    });
  }

  if (route === '/ocs-config') return send(res, 200, buildOcsConfig(origin));

  if (route === '/search') {
    const query = Object.fromEntries(url.searchParams.entries());
    const body = req.method === 'POST' ? await readBody(req) : {};
    const payload = { ...query, ...body };
    if (Array.isArray(payload.options)) payload.options = payload.options.join('\n');
    return send(res, 200, await handleSearch(payload));
  }

  /* ---------- 仅本机可用的管理接口 ---------- */
  if (route.startsWith('/api/') || route === '/config') {
    if (!isLocalRequest(req)) return send(res, 403, { code: 0, msg: '管理接口仅允许本机访问' });

    if (route === '/config') return serveConfigPage(res);

    if (route === '/api/status') {
      return send(res, 200, {
        code: 1,
        data: {
          version: VERSION,
          uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
          bankSize: loadBank().length,
          missSize: readJson(MISS_FILE, []).length,
          threshold: CONFIG.threshold,
          ai: publicConfig()
        }
      });
    }

    if (route === '/api/providers') return send(res, 200, { code: 1, data: PROVIDERS });

    if (route === '/api/config' && req.method === 'GET') {
      return send(res, 200, { code: 1, data: publicConfig() });
    }

    if (route === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) {
      const updated = updateConfig(await readBody(req));
      if (!updated) return send(res, 400, { code: 0, msg: '没有可更新的字段' });
      return send(res, 200, { code: 1, msg: '已保存并立即生效', data: updated });
    }

    if (route === '/api/config/test' && req.method === 'POST') {
      return send(res, 200, await testAiConnection());
    }

    if (route === '/api/bank' && req.method === 'POST') {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      const answer = String(body.answer || '').trim();
      if (!question || !answer) return send(res, 400, { code: 0, msg: 'question 与 answer 均为必填' });
      const bank = loadBank();
      const idx = bank.findIndex((it) => normalize(it.question) === normalize(question));
      if (idx >= 0) bank[idx].answer = answer;
      else bank.push({ question, answer });
      writeJson(BANK_FILE, bank);
      return send(res, 200, { code: 1, msg: idx >= 0 ? '已更新答案' : '已新增题目', bankSize: bank.length });
    }

    return send(res, 404, { code: 0, msg: '接口不存在' });
  }

  /* ---------- 搜题服务与补题（供 OCS / 局域网调用） ---------- */
  if (route === '/add' && req.method === 'POST') {
    if (CONFIG.serverToken && req.headers['x-token'] !== CONFIG.serverToken) {
      return send(res, 401, { code: 0, msg: '缺少或错误的 X-Token' });
    }
    const body = await readBody(req);
    const question = String(body.question || '').trim();
    const answer = String(body.answer || '').trim();
    if (!question || !answer) return send(res, 400, { code: 0, msg: 'question 与 answer 均为必填' });
    const bank = loadBank();
    const idx = bank.findIndex((it) => normalize(it.question) === normalize(question));
    if (idx >= 0) bank[idx].answer = answer;
    else bank.push({ question, answer });
    writeJson(BANK_FILE, bank);
    return send(res, 200, { code: 1, msg: idx >= 0 ? '已更新答案' : '已新增题目', bankSize: bank.length });
  }

  send(res, 404, { code: 0, msg: '接口不存在' });
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[提示] 端口 ${CONFIG.port} 已被占用，说明服务已经在运行。`);
    console.error(`       查看配置：http://127.0.0.1:${CONFIG.port}/config`);
    console.error('       需要重启：先双击 停止.bat，再双击 启动.bat。');
    console.error('');
    process.exit(1);
  }
  console.error('服务启动失败：' + err.message);
  process.exit(1);
});

ensureFiles();

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('=============================================');
  console.log(`  OCS 本地题库 v${VERSION}`);
  console.log('=============================================');
  console.log(`本机访问:   http://127.0.0.1:${CONFIG.port}`);
  for (const ip of lanAddresses()) {
    console.log(`局域网访问: http://${ip}:${CONFIG.port}`);
  }
  console.log(`题目数量: ${loadBank().length}，相似度阈值: ${CONFIG.threshold}`);
  console.log(`AI 兜底: ${CONFIG.ai.enable && CONFIG.ai.apiKey ? `已启用（${CONFIG.ai.model}）` : '未启用'}`);
  console.log('');
  console.log('配置页面:  http://127.0.0.1:' + CONFIG.port + '/config');
  console.log('OCS 配置:  http://127.0.0.1:' + CONFIG.port + '/ocs-config');
  console.log('=============================================');
});
