#!/usr/bin/env node
/**
 * 把自铸大师合进明辨后端 catalog 之前的干跑校验。
 * 不写任何文件，只回答「这张卡能不能进 masters.json」。
 *
 * 用法：node scripts/verify-catalog.mjs taleb [目标catalog目录]
 *       MINGBIAN_CATALOG=/path/to/catalog node scripts/verify-catalog.mjs taleb
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMaster } from '../lib/schema.js';
import { loadLibrary, loadCategories } from '../lib/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// 目标 catalog 目录：默认找同级明辨后端，找不到就要求用参数指定。
// 插件本身不依赖明辨仓库——这个脚本只是「导入前先干跑一遍」的便利工具。
const CATALOG =
  process.env.MINGBIAN_CATALOG ||
  process.argv[3] ||
  resolve(HERE, '..', '..', '..', 'backend', 'src', 'main', 'resources', 'catalog');

const slug = process.argv[2];
if (!slug) {
  console.error('用法：node scripts/verify-catalog.mjs <slug>');
  process.exit(2);
}

const categories = new Set((await loadCategories()).map((c) => c.slug));
const { masters } = await loadLibrary();
const master = masters.find((m) => m.slug === slug);
if (!master) {
  console.error(`本地库里没有 ${slug}`);
  process.exit(1);
}

const problems = validateMaster(master, categories);

// 目标 catalog 是可选检查：没有明辨仓库时只做本地校验，不阻断。
let backend = null;
try {
  backend = JSON.parse(await readFile(join(CATALOG, 'masters.json'), 'utf8'));
} catch {
  console.log(`（跳过目标目录检查：找不到 ${CATALOG}）`);
}

if (backend) {
  const clash = backend.find((m) => m.slug === slug);
  if (clash) console.log(`注意：目标目录已有同 slug「${clash.name}」，导入会覆盖它。`);
  console.log(`下一个可用 sortOrder：${Math.max(...backend.map((m) => m.sortOrder)) + 1}`);
}

if (problems.length > 0) {
  console.error(`✗ ${slug} 不能进目录：\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`✓ ${slug}（${master.name} · ${master.thinkingModel}）可以导入后端 catalog。`);
