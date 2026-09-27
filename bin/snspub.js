#!/usr/bin/env node
// node:sqlite 의 "실험 기능" 경고만 숨깁니다. 다른 경고는 그대로 보입니다.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
