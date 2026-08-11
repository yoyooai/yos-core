# YOS 发布手册

**这份文件是 YOS 出货到生产货架的唯一步骤依据。**
发版前第一件事看它，发完最后一件事更新它。

在这份文件存在之前，发布顺序只写在一次性的验收委托文档里，
每次发版都靠人现回忆 —— 2026-08-10 的 0.1.14 发布就因此走了一版错的顺序
（委托 §7 写的是「先建货架、后打标签」，做不出已验证的 buildId）。
把它放进仓里，是为了让顺序不再随文档走丢。

---

## 一、为什么顺序不能随便换（先看这段，再看步骤）

两条硬性质决定了顺序，不是习惯问题：

1. **`capabilities.json` 只看得见标签。**
   能力目录里的 provider 是从各仓的标签扫出来的。**标签没打之前建货架，
   能力目录就是空的** —— 这正是 0.1.14 之前那几轮反复踩的坑。

2. **`buildId` 把默认分支的提交也算进去了。**
   `buildId = f(各仓默认分支提交, 标签集)`（见 `scripts/build-dist.mjs`
   的 `buildIdentity()`）。**合并进 `main` 之前建货架，算出来的 buildId
   和验收报告里那个对不上**，复核这一步就失去意义。

结论：**先合并、再打标签、然后才能建货架。** 顺序错了不会报错，
只会安静地产出一个空的能力目录或一个对不上的 buildId。

---

## 二、步骤

### 第 1 步 · 合并进 `main`

Core 与 Components 两仓，把通过验收的分支 `--no-ff` 合进 `main`。
合并后确认树与分支尖端逐字节同一棵（合并没有夹带别的东西）。

### 第 2 步 · 打标签

三个标签一次打齐，缺一个货架就少一条线：

| 标签 | 仓 |
|---|---|
| `v<x.y.z>` | `yoyooai/yos-core` |
| `feishu-v<x.y.z>` | `yoyooai/yos-components` |
| `weixin-v<x.y.z>` | `yoyooai/yos-components` |

### 第 3 步 · 在货架机本地构建（**必须带 vendor**）

```bash
node scripts/build-dist.mjs --output <构建目录> \
  --production \
  --repo yoyooai/yos-core=. \
  --repo yoyooai/yos-components=../yos-components \
  --vendor-cache <vendor 缓存目录>
```

- **不要在生产构建里用 `--skip-vendor`。** 隔离验收可以跳过 vendor，
  生产出货跳过就等于把第三方件的取货口丢回公网。
- `--allow-tag-drop` 只在**确实打算淘汰旧标签**时才加。不加它，
  掉标签会直接报红 —— 这是防「旧的钉版本安装地址悄悄变 404」的门禁。
- 完整参数见 `scripts/build-dist.mjs` 头部的 Usage。

### 第 4 步 · 复核（切换之前，一项都不能省）

| 复核项 | 通过标准 |
|---|---|
| 能力目录非空 | `capabilities.json` 里 provider 数 > 0，且新渠道版本在内 |
| buildId | 与验收报告记录的逐字相同 |
| vendor 完整 | vendor 目录齐全，来源地址逐条可读 |
| 历史版本没掉 | `droppedTags` 为空（除非本次就是要淘汰） |
| 包哈希 | 线上包 sha256 与门禁产出的可复现包逐字相同 |
| 标签数 | Core / Components 各自标签数与预期一致 |

### 第 5 步 · 备份旧货架

切换前先留回滚副本，命名带版本和时间戳：

```
/srv/yos-dist.bak-<旧版本>-<YYYYMMDD-HHMM>
```

### 第 6 步 · 原子切换

本地与服务器整体哈希逐字相同**之后**才换入 `/srv/yos-dist/`。
哈希没对上就不换 —— 半套货架比旧货架更糟。

### 第 7 步 · 客户式终验（这一步不能用 HTTP 探活代替）

**`install.sh` 返回 200 不等于装得上。** 必须在一台干净机器上走完整客户路径：

```bash
curl -fsSL https://yoyooai.com/install.sh | bash -s -- -y
yos --version                                  # 应等于本次发布版本
pm2 list                                       # 四个服务 online、restarts=0
yos add feishu && yos add weixin               # 版本号应等于本次发布的渠道版本
yos capability list                            # 能力目录客户端本地能列出新渠道
```

最后一条最容易被漏：能力目录**发布了**和客户端**认得**是两件事，要分别验。

> ⚠️ 干净机器上非交互 ssh 不会 source `.bashrc`，
> 直接跑 `yos` 会报 command not found。用 `bash -lic "yos ..."`。
> 这是测试方法的坑，不是装机失败 —— 别误判。

---

## 三、回滚

把第 5 步的备份目录换回 `/srv/yos-dist/` 即复原。
回滚副本请保留到下一个版本终验通过之后再清。

---

## 四、这份文件的证据来源

- 第 1~6 步的**顺序与两条硬性质**：出自 105 / 109 号验收（buildId 只有在
  `main` 已指向合并后提交时才能逐字复现；标签未打则能力目录为空）。
- 第 7 步：2026-08-11 在干净机上实测走通（0.1.14 / 飞书 0.1.4 / 微信 0.1.3，
  四服务 online，`yos capability list` 认出两个渠道）。
- 第 3~6 步的**具体命令与路径**：`build-dist.mjs` 的用法出自脚本自身；
  `/srv/yos-dist/` 与回滚副本命名出自 0.1.4~0.1.14 各次实际上架记录。
  **货架机上的构建与切换不是本文件作者亲手执行的**，
  首次按本文件发版时请顺手核对一遍路径，有出入就地改这份文件。
