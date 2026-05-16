#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { getQuote } from '../src/core/data.js';
import { setSymbol } from '../src/core/chart.js';

const { values } = parseArgs({
  options: {
    symbol: { type: 'string', short: 's' },
    side: { type: 'string' },
    entry: { type: 'string' },
    stop: { type: 'string' },
    target: { type: 'string' },
    target2: { type: 'string' },
    interval: { type: 'string', short: 'i' },
    once: { type: 'boolean' },
  },
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const side = (values.side || 'buy').toLowerCase();
const entry = numberArg(values.entry, 'entry');
const stop = numberArg(values.stop, 'stop');
const target = numberArg(values.target, 'target');
const target2 = values.target2 ? numberArg(values.target2, 'target2') : null;
const interval = values.interval ? Number(values.interval) : 1000;

if (!token || !chatId) {
  throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID before running this script.');
}
if (!['buy', 'sell'].includes(side)) {
  throw new Error('--side must be buy or sell.');
}

function numberArg(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number.`);
  return n;
}

function crossed(price, level) {
  return side === 'buy' ? price >= level : price <= level;
}

function failed(price, level) {
  return side === 'buy' ? price <= level : price >= level;
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
    const body = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${body}`);
  }
}

function formatSignal(title, quote, extra = '') {
  const price = quote.last ?? quote.close;
  const lines = [
    `<b>${title}</b>`,
    `Symbol: ${quote.symbol}`,
    `Price: ${price}`,
    `Side: ${side.toUpperCase()}`,
    `Entry: ${entry}`,
    `Stop: ${stop}`,
    `Target 1: ${target}`,
  ];
  if (target2 != null) lines.push(`Target 2: ${target2}`);
  if (extra) lines.push(extra);
  return lines.join('\n');
}

async function main() {
  if (values.symbol) {
    await setSymbol({ symbol: values.symbol });
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  let entered = false;
  let target1Hit = false;
  let target2Hit = false;
  let running = true;

  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  const firstQuote = await getQuote({});
  await sendTelegram(formatSignal('TradingView watcher started', firstQuote, 'Waiting for entry condition.'));

  while (running) {
    const quote = await getQuote({});
    const price = quote.last ?? quote.close;

    if (!entered && crossed(price, entry)) {
      entered = true;
      await sendTelegram(formatSignal('ENTRY TRIGGERED', quote));
      if (values.once) break;
    }

    if (entered && !target1Hit && crossed(price, target)) {
      target1Hit = true;
      await sendTelegram(formatSignal('TARGET 1 HIT - book partial profit', quote));
      if (values.once && target2 == null) break;
    }

    if (entered && target2 != null && !target2Hit && crossed(price, target2)) {
      target2Hit = true;
      await sendTelegram(formatSignal('TARGET 2 HIT - exit / trail aggressively', quote));
      if (values.once) break;
    }

    if (entered && failed(price, stop)) {
      await sendTelegram(formatSignal('STOP LOSS / EXIT TRIGGERED', quote));
      break;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

main().catch(err => {
  console.error(JSON.stringify({ success: false, error: err.message }, null, 2));
  process.exit(1);
});
