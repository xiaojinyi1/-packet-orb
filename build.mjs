#!/usr/bin/env node
/**
 * 构建入口。
 *
 * 本机安全策略会拒绝 esbuild 删除系统 Temp 下的临时文件
 * （Vite 打包 Worker 时报 "remove <Temp>\esbuild-...: Access is denied"），
 * 因此在拉起 tsc / vite 之前把 TEMP/TMP 指到项目内 .tmp。
 * 该目录已写入 .gitignore，不进产物。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const tmp = path.join(root, '.tmp');
mkdirSync(tmp, { recursive: true });

const env = { ...process.env, TEMP: tmp, TMP: tmp };
const args = process.argv.slice(2);

function run(scriptArgs) {
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  return result.status ?? 1;
}

if (args.includes('--typecheck-only')) {
  process.exit(run(['node_modules/typescript/bin/tsc', '--noEmit']));
}

const tscStatus = run(['node_modules/typescript/bin/tsc', '--noEmit']);
if (tscStatus !== 0) process.exit(tscStatus);
process.exit(run(['node_modules/vite/bin/vite.js', 'build']));
