/**
 * 大师库：内置目录（随包发 48 位）+ 用户自铸（写在 ~/.dsh/mingbian）。
 *
 * 自铸的大师永远覆盖同 slug 的内置卡，这样重新蒸馏一次就能立刻生效。
 *
 * @module dsh-mingbian/store
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED = join(HERE, '..', 'catalog');

/** 目录里不是大师卡的保留文件名。 */
const RESERVED_FILES = new Set(['categories.json', 'deleted.json']);

/** 用户自铸大师的落盘目录。 */
export function storeDir() {
  return process.env.DSH_MINGBIAN_DIR || join(homedir(), '.dsh', 'mingbian');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** 读取内置分类表。 */
export async function loadCategories() {
  return readJson(join(BUNDLED, 'categories.json'));
}

/** 读取随包的大师卡。 */
export async function loadBundledMasters() {
  return readJson(join(BUNDLED, 'masters.json'));
}

/**
 * 读取用户自铸的大师卡；目录不存在时返回空数组。
 * @returns 自铸大师列表
 */
export async function loadDistilledMasters() {
  const dir = storeDir();
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    // 只收卡片文件：墓碑表和分类表都不是大师卡，混进来会变成一张 slug 为空的幽灵卡。
    if (!file.endsWith('.json') || RESERVED_FILES.has(file)) continue;
    try {
      const master = await readJson(join(dir, file));
      // 兜底：没有合法 slug 的对象一律不收，宁可少一张也不让库里出现无名卡。
      if (master && typeof master.slug === 'string' && master.slug) out.push(master);
    } catch {
      // 坏文件不阻断整库读取：蒸馏落盘前已过校验，这里只剩人为手改的情况。
    }
  }
  return out;
}

/** 墓碑文件：记录被删掉的大师。内置卡不能改随包文件，只能靠它挡掉。 */
function tombstonePath() {
  return join(storeDir(), 'deleted.json');
}

/**
 * 读取墓碑表。
 * @returns { slug: { at } }
 */
export async function loadDeleted() {
  try {
    const raw = JSON.parse(await readFile(tombstonePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 删掉一位大师。
 *
 * 两件事一起做：写墓碑（挡住同名内置卡复活），并删掉自铸的卡文件。
 * 只删文件不写墓碑，内置同 slug 会立刻顶上来；只写墓碑不删文件，导出时还能捞到它。
 * @param slug - 大师 slug
 * @returns 删除后的墓碑表
 */
export async function deleteMaster(slug) {
  const deleted = await loadDeleted();
  deleted[slug] = { at: Date.now() };
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  await writeFile(tombstonePath(), `${JSON.stringify(deleted, null, 2)}\n`, 'utf8');
  await rm(join(dir, `${slug}.json`), { force: true });
  return deleted;
}

/**
 * 把一位大师放回目录。
 * @param slug - 大师 slug
 * @returns 更新后的墓碑表
 */
export async function restoreMaster(slug) {
  const deleted = await loadDeleted();
  delete deleted[slug];
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  await writeFile(tombstonePath(), `${JSON.stringify(deleted, null, 2)}\n`, 'utf8');
  return deleted;
}

/**
 * 合并目录：内置在前，自铸同 slug 覆盖。
 * @returns { masters, distilledSlugs }
 */
export async function loadLibrary() {
  const [bundled, distilled, deleted] = await Promise.all([
    loadBundledMasters(),
    loadDistilledMasters(),
    loadDeleted(),
  ]);
  const bySlug = new Map();
  for (const master of bundled) bySlug.set(master.slug, { ...master, origin: 'bundled' });
  for (const master of distilled) {
    const base = bySlug.get(master.slug);
    bySlug.set(master.slug, { ...master, origin: 'distilled', sortOrder: base?.sortOrder ?? master.sortOrder ?? 999 });
  }
  // 墓碑最后过一遍：被删掉的不管来自内置还是自铸，都不再出现。
  const masters = [...bySlug.values()].filter((master) => !deleted[master.slug]);
  return {
    masters,
    distilledSlugs: distilled.map((m) => m.slug).filter((slug) => !deleted[slug]),
    deletedSlugs: Object.keys(deleted),
  };
}

/**
 * 落盘一张已通过校验的大师卡。
 * @param master - 已校验的大师卡
 * @returns 写入路径
 */
export async function saveMaster(master) {
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${master.slug}.json`);
  await writeFile(path, `${JSON.stringify(master, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * 按 slug 或中文名找大师。
 * @param masters - 合并后的目录
 * @param key - slug 或名字
 * @returns 命中的大师卡或 undefined
 */
export function findMaster(masters, key) {
  const needle = key.trim();
  const lower = needle.toLowerCase();
  return (
    masters.find((m) => m.slug === lower) ??
    masters.find((m) => m.name === needle) ??
    masters.find((m) => m.name.includes(needle)) ??
    masters.find((m) => m.slug.includes(lower))
  );
}
