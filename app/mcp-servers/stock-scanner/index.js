#!/usr/bin/env node
/**
 * Stock Scanner MCP Server
 * Exposes Taiwan stock scanning cache (scan signals, 357 valuation, chips, dividends, EPS)
 * as MCP tools. Cache-first → python fallback for missing data.
 *
 * Env: STOCK_SCANNER_DIR (default: ~/projects/均線糾結掃描系統)
 */

'use strict';

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SCANNER_DIR = process.env.STOCK_SCANNER_DIR
  || path.join(os.homedir(), 'projects', '均線糾結掃描系統');

// ─── helpers ────────────────────────────────────────────────────────────────

function latestFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => !pattern || f.match(pattern))
    .sort()
    .reverse();
  return files.length ? path.join(dir, files[0]) : null;
}

function readJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function tickerJson(subdir, ticker) {
  const p = path.join(SCANNER_DIR, 'cache', subdir, `${ticker}.json`);
  return readJson(p);
}

// ─── tool implementations ────────────────────────────────────────────────────

/**
 * stock_scan_signal — read latest scan_results JSON
 * Returns S1/S2 signals. If ticker given, filters to that stock.
 */
function stockScanSignal({ ticker, universe }) {
  const dir = path.join(SCANNER_DIR, 'cache', 'scan_results');
  // prefer matching universe in filename, fall back to any latest
  const pattern = universe
    ? new RegExp(`_${universe}_close\\.json$`)
    : /\.json$/;
  const file = latestFile(dir, pattern);
  if (!file) {
    return { error: 'scan_results cache not found. Run: python3 main.py --universe all --group close' };
  }

  const data = readJson(file);
  if (!data) return { error: 'Failed to parse scan_results cache' };

  const result = {
    cache_date: data.date || path.basename(file).slice(0, 10),
    cache_file: path.basename(file),
  };

  if (ticker) {
    // Search in both signal1 and signal2 arrays
    const s1 = (data.signal1 || []).find(s => s.code === ticker);
    const s2 = (data.signal2 || []).find(s => s.code === ticker);
    if (!s1 && !s2) {
      result.found = false;
      result.message = `${ticker} has no signal in latest scan (${result.cache_date})`;
    } else {
      result.found = true;
      result.signal = s2 || s1;
      result.signal_type = s2 ? 'S2' : 'S1';
    }
  } else {
    result.signal1_count = (data.signal1 || []).length;
    result.signal2_count = (data.signal2 || []).length;
    result.signal1 = data.signal1 || [];
    result.signal2 = data.signal2 || [];
  }

  return result;
}

/**
 * stock_357_valuation — read latest 357_results JSON
 */
function stock357Valuation({ ticker, universe }) {
  const dir = path.join(SCANNER_DIR, 'cache', '357_results');
  const pattern = universe
    ? new RegExp(`_${universe}\\.json$`)
    : /\.json$/;
  const file = latestFile(dir, pattern);
  if (!file) {
    return { error: '357_results cache not found. Run: python3 main.py --mode 357 --universe tw150 --dry-run' };
  }

  const data = readJson(file);
  if (!data) return { error: 'Failed to parse 357_results cache' };

  const cacheDate = path.basename(file).slice(0, 10);

  if (ticker) {
    // data may be array or object keyed by ticker
    let entry = null;
    if (Array.isArray(data)) {
      entry = data.find(d => d.code === ticker || d.ticker === ticker);
    } else if (typeof data === 'object') {
      entry = data[ticker] || Object.values(data).find(d => d && (d.code === ticker || d.ticker === ticker));
    }
    if (!entry) {
      return { cache_date: cacheDate, found: false, message: `${ticker} not found in 357 cache (${cacheDate})` };
    }
    return { cache_date: cacheDate, found: true, data: entry };
  }

  // return all
  return {
    cache_date: cacheDate,
    cache_file: path.basename(file),
    data,
  };
}

/**
 * stock_chips — read chips cache for a ticker
 */
function stockChips({ ticker }) {
  const data = tickerJson('chips', ticker);
  if (!data) {
    return { error: `Chips cache not found for ${ticker}. Run: python3 main.py --mode prefetch --universe all` };
  }

  // Summarize: last N days of institutional + margin
  const institutional = data.institutional || {};
  const margin = data.margin || {};

  const instDates = Object.keys(institutional).sort().reverse().slice(0, 20);
  const marginDates = Object.keys(margin).sort().reverse().slice(0, 20);

  const recentInst = instDates.reduce((acc, d) => { acc[d] = institutional[d]; return acc; }, {});
  const recentMargin = marginDates.reduce((acc, d) => { acc[d] = margin[d]; return acc; }, {});

  // compute running totals
  let foreignTotal = 0, trustTotal = 0, dealerTotal = 0;
  instDates.forEach(d => {
    foreignTotal += recentInst[d].foreign_net || 0;
    trustTotal += recentInst[d].trust_net || 0;
    dealerTotal += recentInst[d].dealer_net || 0;
  });

  return {
    ticker,
    recent_days: instDates.length,
    institutional_20d_summary: { foreign_net_total: foreignTotal, trust_net_total: trustTotal, dealer_net_total: dealerTotal },
    institutional_recent: recentInst,
    margin_recent: recentMargin,
  };
}

/**
 * stock_dividends — read dividends cache for a ticker
 */
function stockDividends({ ticker }) {
  const data = tickerJson('dividends', ticker);
  if (!data) {
    return { error: `Dividends cache not found for ${ticker}. Run: python3 main.py --mode prefetch --universe all` };
  }
  return { ticker, data };
}

/**
 * stock_eps — read EPS cache for a ticker
 */
function stockEps({ ticker }) {
  const data = tickerJson('eps', ticker);
  if (!data) {
    return { error: `EPS cache not found for ${ticker}. Run: python3 main.py --mode prefetch --universe all` };
  }

  // compute TTM if we have quarters
  let ttm = null;
  if (data.quarters) {
    const quarters = Object.entries(data.quarters).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 4);
    if (quarters.length === 4) {
      ttm = quarters.reduce((sum, [, v]) => sum + (v || 0), 0);
    }
  }

  return { ticker, ttm_eps: ttm, data };
}

/**
 * stock_run_live — fallback: run python3 main.py for a single stock
 * Only use when cache is missing.
 */
function stockRunLive({ ticker, mode }) {
  return new Promise((resolve) => {
    const safeMode = (mode === '357') ? '357' : 'scan';
    const args = safeMode === '357'
      ? ['main.py', '--mode', '357', '--dry-run', ticker]
      : ['main.py', '--dry-run', ticker];

    const timeout = 60000; // 60s
    const child = execFile('python3', args, {
      cwd: SCANNER_DIR,
      timeout,
      env: { ...process.env, PYTHONPATH: SCANNER_DIR },
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: `python3 main.py failed: ${err.message}`, stderr });
        return;
      }
      resolve({ ticker, mode: safeMode, output: stdout, stderr: stderr || undefined });
    });

    child.on('error', (err) => {
      resolve({ error: `Failed to spawn python3: ${err.message}` });
    });
  });
}

// ─── MCP protocol ────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'stock_scan_signal',
    description: '查詢台股均線糾結訊號（S1/S2）。ticker 指定單股，universe 篩選 all/tw150，不填則回傳全部。資料來自本機 cache，零延遲。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。不填則回傳所有訊號。' },
        universe: { type: 'string', enum: ['all', 'tw150'], description: '掃描範圍，預設最新一筆。' },
      },
    },
  },
  {
    name: 'stock_357_valuation',
    description: '查詢台股 357 存股估值（便宜價/合理價/昂貴價、EPS、ROE、概念分類）。資料來自本機 cache。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。不填則回傳整個快照。' },
        universe: { type: 'string', enum: ['tw150', 'all'], description: '快照範圍，預設最新一筆。' },
      },
    },
  },
  {
    name: 'stock_chips',
    description: '查詢台股籌碼面資料：三大法人（外資/投信/自營商）近 20 日買賣超 + 融資融券餘額。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'stock_dividends',
    description: '查詢台股歷年配息紀錄（每年配股/配息金額）。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'stock_eps',
    description: '查詢台股季度 EPS 趨勢及 TTM EPS。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'stock_run_live',
    description: 'Fallback：當 cache 沒有資料時，即時跑 python3 main.py 查詢單一股票。速度較慢（30–60s）。',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: '股票代號，如 2330。' },
        mode: { type: 'string', enum: ['scan', '357'], description: '掃描模式，預設 scan。' },
      },
      required: ['ticker'],
    },
  },
];

function respond(id, result) {
  const msg = { jsonrpc: '2.0', id, result };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function respondError(id, code, message) {
  const msg = { jsonrpc: '2.0', id, error: { code, message } };
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'stock-scanner', version: '1.0.0' },
    });
  }

  if (method === 'tools/list') {
    return respond(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    let result;

    try {
      switch (name) {
        case 'stock_scan_signal':   result = stockScanSignal(args); break;
        case 'stock_357_valuation': result = stock357Valuation(args); break;
        case 'stock_chips':         result = stockChips(args); break;
        case 'stock_dividends':     result = stockDividends(args); break;
        case 'stock_eps':           result = stockEps(args); break;
        case 'stock_run_live':      result = await stockRunLive(args); break;
        default:
          return respondError(id, -32601, `Unknown tool: ${name}`);
      }
    } catch (err) {
      result = { error: err.message };
    }

    return respond(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  }

  // notifications (no id) — ignore silently
  if (id === undefined || id === null) return;

  respondError(id, -32601, `Method not found: ${method}`);
}

// ─── stdio transport ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  await handleRequest(req);
});

rl.on('close', () => process.exit(0));
