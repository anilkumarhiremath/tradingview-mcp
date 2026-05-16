#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { get as getWatchlist } from '../src/core/watchlist.js';
import { setSymbol } from '../src/core/chart.js';
import { getOhlcv, getQuote } from '../src/core/data.js';

const { values } = parseArgs({
  options: {
    symbols: { type: 'string', short: 's' },
    top: { type: 'string', short: 'n' },
    side: { type: 'string' },
    minScore: { type: 'string' },
    interval: { type: 'string', short: 'i' },
    watch: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage:
  node scripts/telegram_smart_alerts.js [options]

Options:
  --symbols NSE:SUZLON,NSE:ICICIBANK   Comma-separated symbols. Defaults to TradingView watchlist.
  --side both|buy|sell                  Direction to report. Default: both.
  --top 5                               Number of candidates to send. Default: 5.
  --minScore 60                         Minimum score for alerts. Default: 60.
  --watch                               Monitor the highest-scoring candidate after scan.
  --interval 3000                       Monitor interval in ms. Default: 3000.

Env:
  TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.`);
  process.exit(0);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before running this script.');
}

const topN = Number(values.top || 5);
const minScore = Number(values.minScore || 60);
const sideFilter = (values.side || 'both').toLowerCase();
const interval = Number(values.interval || 3000);

if (!['both', 'buy', 'sell'].includes(sideFilter)) {
  throw new Error('--side must be both, buy, or sell.');
}

function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

async function sendTelegram(text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  }
}

function avg(items) {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + item, 0) / items.length;
}

function pct(from, to) {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function analyzeBars(symbol, bars, marketBias) {
  const last = bars.at(-1);
  const previous = bars.slice(0, -1);
  const recent5 = bars.slice(-5);
  const recent20 = bars.slice(-21, -1);
  const recent50 = bars.slice(-51, -1);
  const ranges = bars.slice(-14).map(bar => Math.max(0.01, bar.high - bar.low));

  const previousHigh = Math.max(...recent20.map(bar => bar.high));
  const previousLow = Math.min(...recent20.map(bar => bar.low));
  const high50 = Math.max(...recent50.map(bar => bar.high));
  const low50 = Math.min(...recent50.map(bar => bar.low));
  const avgRange = avg(ranges);
  const avgVolume = avg(previous.slice(-50).map(bar => bar.volume || 0));
  const recentVolume = avg(recent5.map(bar => bar.volume || 0));
  const volumeRatio = avgVolume ? recentVolume / avgVolume : 1;
  const trend30 = pct(bars.at(-31)?.close || bars[0].close, last.close);
  const momentum5 = pct(bars.at(-6)?.close || bars[0].close, last.close);
  const closePosition = high50 === low50 ? 0.5 : (last.close - low50) / (high50 - low50);
  const breakout = last.close > previousHigh;
  const breakdown = last.close < previousLow;
  const nearHigh = closePosition >= 0.7;
  const nearLow = closePosition <= 0.3;

  let buyScore = 0;
  if (trend30 > 0) buyScore += Math.min(25, trend30 * 8);
  if (momentum5 > 0) buyScore += Math.min(20, momentum5 * 12);
  if (volumeRatio > 1) buyScore += Math.min(20, (volumeRatio - 1) * 18);
  if (nearHigh) buyScore += 15;
  if (breakout) buyScore += 20;
  if (marketBias === 'bullish') buyScore += 10;
  if (marketBias === 'bearish') buyScore -= 10;

  let sellScore = 0;
  if (trend30 < 0) sellScore += Math.min(25, Math.abs(trend30) * 8);
  if (momentum5 < 0) sellScore += Math.min(20, Math.abs(momentum5) * 12);
  if (volumeRatio > 1) sellScore += Math.min(20, (volumeRatio - 1) * 18);
  if (nearLow) sellScore += 15;
  if (breakdown) sellScore += 20;
  if (marketBias === 'bearish') sellScore += 10;
  if (marketBias === 'bullish') sellScore -= 10;

  const buyEntry = round(Math.max(last.close, previousHigh));
  const buyStop = round(Math.min(previousLow, last.close - avgRange * 1.2));
  const buyRisk = Math.max(0.01, buyEntry - buyStop);
  const sellEntry = round(Math.min(last.close, previousLow));
  const sellStop = round(Math.max(previousHigh, last.close + avgRange * 1.2));
  const sellRisk = Math.max(0.01, sellStop - sellEntry);

  return {
    symbol,
    last: round(last.close),
    trend30: round(trend30),
    momentum5: round(momentum5),
    volumeRatio: round(volumeRatio, 2),
    buy: {
      side: 'buy',
      score: Math.max(0, Math.round(buyScore)),
      entry: buyEntry,
      stop: buyStop,
      target1: round(buyEntry + buyRisk * 1.5),
      target2: round(buyEntry + buyRisk * 2.5),
      reason: `${breakout ? 'breakout, ' : ''}${nearHigh ? 'near high, ' : ''}trend ${round(trend30)}%, vol ${round(volumeRatio, 2)}x`,
    },
    sell: {
      side: 'sell',
      score: Math.max(0, Math.round(sellScore)),
      entry: sellEntry,
      stop: sellStop,
      target1: round(sellEntry - sellRisk * 1.5),
      target2: round(sellEntry - sellRisk * 2.5),
      reason: `${breakdown ? 'breakdown, ' : ''}${nearLow ? 'near low, ' : ''}trend ${round(trend30)}%, vol ${round(volumeRatio, 2)}x`,
    },
  };
}

async function readBarsFor(symbol) {
  await setSymbol({ symbol });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const result = await getOhlcv({ count: 120, summary: false });
  return result.bars || [];
}

async function getSymbols() {
  if (values.symbols) {
    return values.symbols.split(',').map(s => s.trim()).filter(Boolean);
  }
  const watchlist = await getWatchlist();
  return watchlist.symbols.map(item => item.symbol).filter(Boolean);
}

async function getMarketBias(symbols) {
  const marketSymbols = ['NSE:NIFTY', 'NSE:BANKNIFTY'].filter(sym => symbols.includes(sym));
  const moves = [];
  for (const symbol of marketSymbols) {
    try {
      const bars = await readBarsFor(symbol);
      const last = bars.at(-1);
      const base = bars.at(-31) || bars[0];
      if (last && base) moves.push(pct(base.close, last.close));
    } catch {
      // Market confirmation is useful, but it should not block scanning.
    }
  }
  const move = avg(moves);
  if (move > 0.12) return 'bullish';
  if (move < -0.12) return 'bearish';
  return 'neutral';
}

function selectCandidates(scans) {
  const candidates = [];
  for (const scan of scans) {
    if (sideFilter !== 'sell') candidates.push({ symbol: scan.symbol, last: scan.last, ...scan.buy });
    if (sideFilter !== 'buy') candidates.push({ symbol: scan.symbol, last: scan.last, ...scan.sell });
  }
  return candidates
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

function formatScan(candidates, marketBias) {
  if (candidates.length === 0) {
    return `<b>TradingView smart scan</b>\nMarket bias: ${marketBias}\nNo candidate passed score >= ${minScore}. No trade is also a valid trade.`;
  }

  const lines = [
    '<b>TradingView smart scan</b>',
    `Market bias: ${marketBias}`,
    `Minimum score: ${minScore}`,
    '',
  ];

  candidates.forEach((item, index) => {
    lines.push(
      `<b>${index + 1}. ${item.side.toUpperCase()} ${item.symbol}</b>`,
      `Score: ${item.score}/100 | Last: ${item.last}`,
      `Entry: ${item.entry} | Stop: ${item.stop}`,
      `Target 1: ${item.target1} | Target 2: ${item.target2}`,
      `Why: ${item.reason}`,
      ''
    );
  });

  return lines.join('\n').trim();
}

function crossed(side, price, level) {
  return side === 'buy' ? price >= level : price <= level;
}

function failed(side, price, level) {
  return side === 'buy' ? price <= level : price >= level;
}

async function monitorCandidate(candidate) {
  await setSymbol({ symbol: candidate.symbol });
  await new Promise(resolve => setTimeout(resolve, 1200));
  await sendTelegram(`<b>Monitoring ${candidate.side.toUpperCase()} ${candidate.symbol}</b>\nEntry: ${candidate.entry}\nStop: ${candidate.stop}\nTarget 1: ${candidate.target1}\nTarget 2: ${candidate.target2}`);

  let entered = false;
  let target1Hit = false;
  let target2Hit = false;
  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    const quote = await getQuote({});
    const price = quote.last ?? quote.close;

    if (!entered && crossed(candidate.side, price, candidate.entry)) {
      entered = true;
      await sendTelegram(`<b>ENTRY TRIGGERED</b>\n${candidate.side.toUpperCase()} ${candidate.symbol}\nPrice: ${price}\nStop: ${candidate.stop}\nTarget 1: ${candidate.target1}\nTarget 2: ${candidate.target2}`);
    }

    if (entered && !target1Hit && crossed(candidate.side, price, candidate.target1)) {
      target1Hit = true;
      await sendTelegram(`<b>TARGET 1 HIT</b>\n${candidate.symbol}\nPrice: ${price}\nBook partial profit and trail stop.`);
    }

    if (entered && !target2Hit && crossed(candidate.side, price, candidate.target2)) {
      target2Hit = true;
      await sendTelegram(`<b>TARGET 2 HIT</b>\n${candidate.symbol}\nPrice: ${price}\nConsider full exit or tight trailing stop.`);
    }

    if (entered && failed(candidate.side, price, candidate.stop)) {
      await sendTelegram(`<b>STOP / EXIT TRIGGERED</b>\n${candidate.symbol}\nPrice: ${price}`);
      break;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function main() {
  const symbols = await getSymbols();
  const uniqueSymbols = [...new Set(symbols)].slice(0, 30);
  if (uniqueSymbols.length === 0) throw new Error('No symbols found. Open your watchlist or pass --symbols.');

  const marketBias = await getMarketBias(uniqueSymbols);
  const scans = [];

  for (const symbol of uniqueSymbols) {
    try {
      const bars = await readBarsFor(symbol);
      if (bars.length >= 60) scans.push(analyzeBars(symbol, bars, marketBias));
    } catch (err) {
      process.stderr.write(`[scan] skipped ${symbol}: ${err.message}\n`);
    }
  }

  const candidates = selectCandidates(scans);
  await sendTelegram(formatScan(candidates, marketBias));

  if (values.watch && candidates[0]) {
    await monitorCandidate(candidates[0]);
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
  process.exit(1);
});
