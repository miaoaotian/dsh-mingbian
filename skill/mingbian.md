# 明辨 · mingbian

> **大师卡只代表一种思维方式，不代表大师本人。** 卡片是模型根据公开材料抽象出的思维框架，
> 不是本人言论或人格；被引用姓名的真实人物没有参与本项目。向用户呈现结论时不要暗示这是真人观点。

把一个**人物 / 一本书 / 一套思想体系**蒸馏成明辨目录格式的**大师卡**，落盘后立刻能上桌，也可以直接导出成正式大师。

产物就是 `backend/src/main/resources/catalog/masters.json` 里的一个元素——**导出即用**。

## 什么时候用

- 「把塔勒布蒸馏成大师」
- 「《孙子兵法》也能做一张卡吗」
- 「让三位大师就这个 offer 该不该接吵一架」
- 「我刚蒸馏的那个人，跟芒格、王兴一起上桌」

## 面板

左侧图标栏的「明辨」图标（或右侧栏的明辨标签）打开面板：

- **分类筛选**：11 个思维分类，每个带当前人数；点一下只看这一类
- **大师卡**：思维模型、口吻、启发式、反模式，以及**内在张力**与**诚实边界**（单独强调）
- **开圆桌**：点名单里的 ＋ 请人上桌，**1–6 位**都行，一人也值得问
- **流式**：大师的话一个字一个字出来，不用等整段
- **追问**：一场圆桌可以接着问，历史上下文自动带进下一轮
- **深思**：默认开启。关掉走快答（120–180 字），开启走深答（260–400 字，要求给依据、反例和失效条件）

## 两个工具

| 工具 | 作用 |
|---|---|
| `distill_master` | 蒸馏一张大师卡。校验通过才落盘；不通过会带问题重试一次，仍不合格就报错不落盘 |
| `master_roundtable` | 1–6 位大师各发言（深答 260–400 字 / 快答 120–180 字），再由主持人收敛共识、分歧、结论 |

## 大师卡字段

与 `masters.json` 逐字段一致：

| 字段 | 含义 |
|---|---|
| `slug` / `name` / `avatarType` | 标识、显示名、`PERSON` 或 `BOOK` |
| `categories` | 1–3 个思维分类 slug（必须来自 `categories.json`） |
| `thinkingModel` | 主心智模型 |
| `summary` / `voice` | 一句话世界观；口吻要具体到句长、比喻、施压方式 |
| `models` / `heuristics` / `antiPatterns` | 补充模型、可执行启发式、他明确不做的事 |
| `tension` / `boundary` | 内在张力；这套框架解释不了什么 |
| `tags` / `consultationDomains` | 检索短词、专长领域 |
| `intakeQuestions` / `guardrails` | 他会先问的问题；这条思路的安全边界 |

`tension` 和 `boundary` 是硬要求，不是免责声明——**一个没有边界的思维模型会变成万能答案生成器**，那样它就不值得上桌了。

## 蒸馏纪律

- 蒸馏的是**思维模型**，不是台词模仿。每个模型都要能推出判断，不能只是金句。
- 口吻要能通过盲测：遮住名字也应该认得出是谁。
- 不编造隐私、未公开言论、具体数字或他人原话。
- 对象缺乏可迁移框架时，仍然出卡，但在 `boundary` 里写清它只适合什么场景。

## 落盘位置

- 内置目录：随包 `catalog/masters.json`（48 位）
- 自铸大师：`~/.dsh/mingbian/<slug>.json`（可用 `DSH_MINGBIAN_DIR` 覆盖）

同 `slug` 的自铸卡永远覆盖内置卡——重新蒸馏一次就立刻生效。

## 上桌与导出

- **上桌**：不用做任何事，`master_roundtable` 直接读本地库。
- **导入明辨**：

```bash
cp ~/.dsh/mingbian/<slug>.json /tmp/new-master.json
python3 - <<'EOF'
import json
path = 'backend/src/main/resources/catalog/masters.json'
masters = json.load(open(path))
new = json.load(open('/tmp/new-master.json'))
new['sortOrder'] = max(m['sortOrder'] for m in masters) + 1
masters = [m for m in masters if m['slug'] != new['slug']] + [new]
json.dump(masters, open(path, 'w'), ensure_ascii=False, indent=1)
EOF
```

## 无 Key 设计

插件不自带 API Key：所有生成都走宿主已配好的 provider/model。想指定别的模型，在插件配置里写：

```yaml
- id: dsh-mingbian
  name: 'dsh-mingbian'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

## 延迟

三人桌 = 三次并行短判断 + 一次主持人收敛，共两轮。不追加决策简报，不做第四轮追问——那是 App 里的活，不是会话里的活。


## 删除与恢复

任何大师都能从目录里删掉，**内置的也能**——删除靠墓碑挡住，随包的 `catalog/masters.json` 一个字不改。

- 面板里：详情页点「删除」，再点一次「确认删除？」
- 命令行：`DELETE /mingbian/master/<slug>`，恢复用 `POST /mingbian/master/<slug>/restore`
- **已删**筛选条里能看到删掉的，点 ↺ 就放回来

删除是本地行为：内置卡不会被真正移除，换台机器重新装插件它们就回来了。真想永久去掉，改 `catalog/masters.json`。

## 流式与多轮

面板走 `POST /mingbian/stream`（SSE）。事件序列：

```
session → thinking → seats → take-start → take-delta… → take-end
       → host-start → host-delta… → turn → end
```

`turn` 事件是这一轮的成品；服务端同时把它追加到会话里。追问只需回传 `sessionId`，不用再传 `masters`——座位上的人沿用，历史自动拼进提示词。

会话存在进程内存里，最近 40 场，重启即失效——这些是「刚才那场讨论」的临时上下文，长期留存属于明辨 App 的职责。
