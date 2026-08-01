// Version: 1.0.0
/**
 * 极简 .env 加载器（零依赖）：启动时读取仓库根目录 .env，
 * 仅填充尚未存在的环境变量（已有环境变量优先，便于临时覆盖）。
 * 凭证纪律（附录 A）：key 只经此通道进入进程，不进 Bundle / Script / git。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadDotEnv(dir: string = process.cwd()): void {
  let text: string;
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return; // 无 .env 不视为错误（CI / 纯环境变量场景）
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key !== '' && value !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
