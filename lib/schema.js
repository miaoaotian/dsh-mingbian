/**
 * 大师卡的 schema 契约 —— 与明辨后端
 * backend/src/main/resources/catalog/masters.json 保持逐字段一致。
 *
 * 蒸馏出来的一切都必须先过这里再落盘：宁可报错重试，也不让半成品进入目录。
 * 「导出即用」的承诺就压在这一个文件上。
 *
 * @module dsh-mingbian/schema
 */

/** 允许的 avatarType；明辨前端用 PERSON / BOOK 分支渲染头像。 */
export const AVATAR_TYPES = ['PERSON', 'BOOK'];

/** 大师卡必填字段及其类型。slug 之外全部是生成内容。 */
const REQUIRED = {
  slug: 'string',
  name: 'string',
  avatarType: 'string',
  categories: 'array',
  thinkingModel: 'string',
  summary: 'string',
  voice: 'string',
  models: 'array',
  heuristics: 'array',
  antiPatterns: 'array',
  tension: 'string',
  boundary: 'string',
  tags: 'array',
  consultationDomains: 'array',
};

/** 咨询技能卡必填字段，对应 consultation-skills.json。 */
const REQUIRED_SKILL = {
  domains: 'array',
  intakeQuestions: 'array',
  method: 'string',
  guardrails: 'array',
};

/** slug 与明辨目录同规则：小写字母数字，单词间单连字符。 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkStrings(value, field, problems, { min = 0, max = 6 } = {}) {
  if (typeOf(value) !== 'array') {
    problems.push(`${field} 必须是数组`);
    return;
  }
  if (value.length < min || value.length > max) {
    problems.push(`${field} 需要 ${min}-${max} 项，实际 ${value.length} 项`);
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') problems.push(`${field}[${index}] 必须是字符串`);
    else if (!item.trim()) problems.push(`${field}[${index}] 不能为空`);
  });
}

/**
 * 校验一张大师卡。返回问题列表，空数组代表可以直接落盘。
 * @param master - 候选大师卡
 * @param categories - 合法的思维分类 slug 集合
 * @returns 人读的问题描述
 */
export function validateMaster(master, categories) {
  const problems = [];
  if (typeOf(master) !== 'object' || master === null) return ['大师卡必须是对象'];

  for (const [field, kind] of Object.entries(REQUIRED)) {
    if (master[field] === undefined) {
      problems.push(`缺少字段 ${field}`);
      continue;
    }
    if (typeOf(master[field]) !== kind) problems.push(`${field} 必须是 ${kind}`);
  }
  if (problems.length > 0) return problems;

  if (!SLUG.test(master.slug)) {
    problems.push(`slug "${master.slug}" 不合规：只能小写字母数字与单连字符`);
  }
  if (!AVATAR_TYPES.includes(master.avatarType)) {
    problems.push(`avatarType 只能是 ${AVATAR_TYPES.join(' / ')}`);
  }
  if (master.categories.length < 1 || master.categories.length > 3) {
    problems.push(`categories 需要 1-3 项，实际 ${master.categories.length} 项`);
  }
  for (const slug of master.categories) {
    if (!categories.has(slug)) problems.push(`未知思维分类 "${slug}"`);
  }

  checkStrings(master.models, 'models', problems, { min: 1, max: 4 });
  checkStrings(master.heuristics, 'heuristics', problems, { min: 2, max: 6 });
  checkStrings(master.antiPatterns, 'antiPatterns', problems, { min: 1, max: 4 });
  checkStrings(master.tags, 'tags', problems, { min: 1, max: 5 });
  checkStrings(master.consultationDomains, 'consultationDomains', problems, { min: 1, max: 4 });

  // 这些是「大师得像这个人」的最低要求：voice 是口吻，tension/boundary 是诚实的自我限制。
  if (master.voice.trim().length < 20) problems.push('voice 太短（少于 20 字），需要能遮住名字仍认得出是谁');
  if (master.tension.trim().length < 10) problems.push('tension 太短，需要写出同时成立的内在冲突');
  if (master.boundary.trim().length < 10) problems.push('boundary 太短，需要写出这套框架解释不了什么');
  if (master.summary.trim().length < 20) problems.push('summary 太短（少于 20 字）');

  return problems;
}

/**
 * 校验一张咨询技能卡。
 * @param skill - 候选技能卡
 * @returns 人读的问题描述
 */
export function validateSkillCard(skill) {
  const problems = [];
  if (typeOf(skill) !== 'object' || skill === null) return ['咨询技能卡必须是对象'];
  for (const [field, kind] of Object.entries(REQUIRED_SKILL)) {
    if (typeOf(skill[field]) !== kind) problems.push(`${field} 必须是 ${kind}`);
  }
  if (problems.length > 0) return problems;
  checkStrings(skill.domains, 'domains', problems, { min: 1, max: 4 });
  checkStrings(skill.intakeQuestions, 'intakeQuestions', problems, { min: 1, max: 3 });
  checkStrings(skill.guardrails, 'guardrails', problems, { min: 1, max: 4 });
  if (skill.method.trim().length < 15) problems.push('method 太短（少于 15 字）');
  return problems;
}

/**
 * 把名字折成合法 slug，供没给 slug 时兜底。
 * @param name - 人物/书名
 * @returns kebab-case slug，纯中文输入会返回空串由调用方处理
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
