#!/usr/bin/env node
// Node 22.13 미만에서는 내장 SQLite 를 쓸 수 없어 알아보기 어려운 오류가 나므로 먼저 안내합니다.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13 이상이 필요합니다 (지금 ${process.versions.node}). 터미널에서 "brew upgrade node" 로 올려 주세요.`);
  process.exit(1);
}

// node:sqlite 의 "실험 기능" 경고만 숨깁니다. 다른 경고는 그대로 보입니다.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
