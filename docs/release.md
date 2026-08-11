# YOS 发布手册

**这份文件是 YOS 出货到生产货架的唯一步骤依据。**
发版前第一件事看它，发完最后一件事更新它。

在这份文件存在之前，发布顺序只写在一次性的验收委托文档里，
每次发版都靠人现回忆 —— 2026-08-10 的 0.1.14 发布就因此走了一版错的顺序
（委托 §7 写的是「先建货架、后打标签」，做不出已验证的 buildId）。
把它放进仓里，是为了让顺序不再随文档走丢。

---

## 一、为什么顺序不能随便换（先看这段，再看步骤）

三条硬性质决定了顺序，不是习惯问题：

1. **`capabilities.json` 只看得见标签。**
   能力目录里的 provider 是从各仓**已镜像的标签**里挑出来的
   （`scripts/lib/capability-index.mjs` 的 `newestReleaseTag()`：按组件的
   `tagPrefix` 过滤，再取版本号最大的那个）。**标签没打之前建货架，
   能力目录就是空的。**

2. **`buildId` 把默认分支的提交也算进去了。**
   `buildId = f(各仓默认分支提交, 标签集)`（见 `scripts/build-dist.mjs`
   的 `buildIdentity()`）。**`main` 落到已验收提交之前建货架，算出来的
   buildId 和验收报告里那个对不上**，复核这一步就失去意义。

3. **标签保留数会决定 provider 在不在。**
   provider 是从**镜像里的**标签集挑的，不是从 GitHub 挑的。
   如果保留数把某个组件仅剩的标签淘汰掉，那个 provider 就从能力目录消失。
   所以保留数是发布参数，不是清理参数。

结论：**先让 `main` 精确落在已验收提交、再打标签、然后才能建货架。**
顺序错了不会报错，只会安静地产出一个空的能力目录或一个对不上的 buildId。

---

## 二、步骤

### 第 0 步 · 版本号那四个文件（在这份文件的范围之外）

改版本号、`package-lock.json`、`CHANGELOG.md`、`docs/progress.md` 那一组动作，
口径在 `CLAUDE.md`「Release Process」，**不在这里重复一遍**（两处写会漂）。
本文件从「已经有一个通过验收的提交」开始。

### 第 1 步 · 让 `main` 精确落在已验收提交（**不许 `--no-ff`**）

**发布主干必须就是被验收的那一个提交对象，不是一个和它内容相同的新提交。**

```bash
git checkout main
git merge --ff-only <已验收提交>
git push origin main:main

# 核验：远端 main 必须逐字等于验收报告里的提交号
git ls-remote origin refs/heads/main
git rev-parse HEAD
```

**推完必须核指向，不能只看 push 有没有报错。** `git push` 成功只说明
远端接受了这次更新，不说明远端 `main` 就是你以为的那个对象
（本地 `main` 落后、推错分支、推了别的远端，都能"成功"）。
`ls-remote` 的输出与验收报告里的 sha 逐字比对，这一步才算完。

- **不要用 `--no-ff`。** `--no-ff` 造出来的合并提交是一个**从未被验收过的
  新 sha**（树可能一模一样，但对象不是同一个）。发布之后 buildId、标签、
  审计链指向的都该是被人看过的那个对象。
- **`--ff-only` 推不动就说明分叉了**：这时候不许改用合并提交绕过去。
  正确做法是把分支重新落到 `main` 之上，**重新走验收**，拿到新的已验收提交。
- 两仓（Core、Components）各自都要满足这一条。

### 第 2 步 · 打标签（**只给发生变化的组件打**）

OS、飞书、微信是**三个独立组件，各自独立发布**。
**只给这一轮真正变化了的组件打新标签**，没变的不要陪着升。

| 组件 | 标签形态 | 仓 |
|---|---|---|
| OS 主体 | `v<x.y.z>` | `yoyooai/yos-core` |
| 飞书渠道 | `feishu-v<x.y.z>` | `yoyooai/yos-components` |
| 微信渠道 | `weixin-v<x.y.z>` | `yoyooai/yos-components` |

**没变的组件不会因为没打标签而掉出货架**：能力目录取的是该组件
`tagPrefix` 下版本号最大的**已镜像标签**，它上一版的标签还在，
provider 就还在。（这也是第 3 步保留数必须够大的原因。）

```bash
# 打（-a 带注解，留下是谁在什么时候发的）
git tag -a v<x.y.z> -m "release <x.y.z>" <已验收提交>
git push origin refs/tags/v<x.y.z>

# 核验：注解标签要解引用到已验收提交
git ls-remote origin 'refs/tags/v<x.y.z>*'
#   refs/tags/v<x.y.z>        <标签对象>      ← 注解标签自己
#   refs/tags/v<x.y.z>^{}     <已验收提交>    ← 这一行才是要比对的
```

**看 `^{}` 那一行。** 注解标签的第一行是标签对象的 sha，不是提交 sha；
拿它去和验收报告比会永远对不上，然后有人就会去"修"一个不存在的问题。
渠道标签同理（`feishu-v<x.y.z>` / `weixin-v<x.y.z>`）。

### 第 3 步 · 在货架机本地构建（**必须带 vendor**）

```bash
node scripts/build-dist.mjs --output <构建目录> \
  --production \
  --tags 50 \
  --base-url https://yoyooai.com/dist \
  --repo yoyooai/yos-core=. \
  --repo yoyooai/yos-components=../yos-components \
  --vendor-cache <vendor 缓存目录>
```

- `--production` —— 生产模式，与 `--test-only` 互斥，写错会 `conflict`。
- `--tags 50` —— 保留数写明，不靠默认值。见上面第 3 条硬性质：
  这个数字小了会让 provider 消失、让公开过的钉版本安装地址变 404。
- `--base-url https://yoyooai.com/dist` —— 货架里生成的地址以此为前缀，
  写错客户就取不到货。
- **不要在生产构建里用 `--skip-vendor`。** 隔离验收可以跳过 vendor，
  生产出货跳过就等于把第三方件的取货口丢回公网。
- `--allow-tag-drop` 只在**确实打算淘汰旧标签**时才加。不加它，
  掉标签会直接报红 —— 这是防「旧的钉版本安装地址悄悄变 404」的门禁。

### 第 4 步 · 切换前复核（一项都不能省）

| 复核项 | 通过标准 |
|---|---|
| 能力目录非空 | `capabilities.json` provider 数 > 0，本轮新版本在内，**没变的组件也还在** |
| buildId | 与验收报告记录的逐字相同 |
| vendor 完整 | vendor 目录齐全，来源地址逐条可读 |
| 历史版本没掉 | `droppedTags` 为空（除非本次就是要淘汰，且已加 `--allow-tag-drop`） |
| 包哈希 | 构建产出的包 sha256 与门禁产出的可复现包逐字相同 |
| 标签数 | Core / Components 各自标签数与预期一致 |
| **清单摘要** | **记下 `sha256sum <构建目录>/index.json`**，第 7 步要拿它去卡 |

**最后一行别省。** `index.json` 是唯一无法登记自己哈希的文件，而 `buildId`
**不覆盖它的文件清单**（buildId 只由各仓提交与标签算出）—— 一个把某个包
悄悄从清单里删掉的 `index.json`，buildId 和诚实的那份**一模一样**。
所以清单本身只能靠"切换前在本地量一次、切换后从公网量一次、两次对上"来卡。

### 第 5 步 · 备份（**本地副本 + 站外备份，两份都要**）

> 🔴 **第一件事是解析出真实目录。** 第 6 步改造之后 `/srv/yos-dist` 是一根
> **符号链接**，直接 `cp -a /srv/yos-dist ...` 复制到的是**那根链接**，
> 不是货架内容 —— 打出来的包里只有一条指回货架机绝对路径的链接。
> 2026-08-11 在同构布局上实测：这样打出的包 **122 字节**，在备份机上解开
> 是一根**悬空链接**，货架内容一个字节都没有。**这种包看起来毫无异样**
> ——坏包 283B 比好包 266B 还大，**包大小不能当健康信号**。

```bash
STAMP=$(date +%Y%m%d-%H%M)
OLD=<旧版本>
BAK=/srv/yos-dist.bak-$OLD-$STAMP

# ⓿ 解析真实目录，并当场断言它是真目录 —— 这一步不许省
REAL=$(readlink -f /srv/yos-dist)
echo "real shelf dir: $REAL"
test -d "$REAL" && test ! -L "$REAL" || { echo "REAL 不是真目录，停下查布局"; exit 1; }

# ① 本地回滚副本（同机，换得快）—— 复制真实目录，不是那根链接
cp -a "$REAL" "$BAK"
test ! -L "$BAK" || { echo "副本是链接，说明 ⓿ 被跳过了"; exit 1; }

# ② 打包 + 记哈希（哈希要和包一起走，否则恢复时无从判断包坏没坏）
tar -C /srv -czf /var/backups/yos-dist-$OLD-$STAMP.tar.gz "$(basename "$BAK")"
sha256sum /var/backups/yos-dist-$OLD-$STAMP.tar.gz \
  > /var/backups/yos-dist-$OLD-$STAMP.tar.gz.sha256

# ③ 打完立刻数包里有多少条 —— 一条链接和一整个货架，只有这里分得出来
tar -tzf /var/backups/yos-dist-$OLD-$STAMP.tar.gz | wc -l    # 应是几百条以上
tar -tzf /var/backups/yos-dist-$OLD-$STAMP.tar.gz | head -3   # 第一条必须是目录，不是 ->

# ④ 推到另一台机器（--checksum 按内容比，不信时间戳）
rsync -av --checksum \
  /var/backups/yos-dist-$OLD-$STAMP.tar.gz{,.sha256} \
  <备份机>:/srv/yos-dist-backups/
```

**恢复验证（必须在备份机上做，不能在货架机上做）** —— 备份没验过就等于没有：

```bash
cd /srv/yos-dist-backups
sha256sum -c yos-dist-$OLD-$STAMP.tar.gz.sha256   # 包本身没坏
mkdir -p /tmp/restore && tar -xzf yos-dist-$OLD-$STAMP.tar.gz -C /tmp/restore

# 解出来的必须是真目录。是链接就说明打包时踩了上面那个坑
test ! -L /tmp/restore/yos-dist.bak-$OLD-$STAMP \
  || { echo "包里只有一根链接，这份备份是空的"; exit 1; }

# 逐个文件按它自己的 index.json 核 —— 能解开 ≠ 每个字节都还在
node scripts/verify-public-shelf.mjs --local /tmp/restore/yos-dist.bak-$OLD-$STAMP --full
```

- ⚠️ **为什么恢复演练不能在货架机上做**：货架机上那条绝对路径是存在的，
  所以即使包里只有一根链接，`--local` 也会顺着链接读到真货架、**报 PASS**。
  2026-08-11 实测确认过这个假通过。在备份机上做才有意义 ——
  那台机器没有这条路径，链接立刻悬空报红。
- 本地副本用来**快速回退**；站外备份用来**扛住货架机本身出事**。
  只有本地副本等于没有备份 —— 机器没了，回滚副本跟着一起没。
- **`tar` 能解开不代表内容没缺。** 上面最后一条命令是唯一能证明
  "这份备份真能拿来恢复"的做法，`--local` 就是为它加的。
- 站外备份要记下**存放位置**和**包的 sha256**，写进本轮发布记录。
- 两份备份都保留到下一个版本终验通过之后再清。

### 第 6 步 · 原子切换

**本地与服务器整体哈希逐字相同之后**才换入。哈希没对上就不换 ——
半套货架比旧货架更糟。

**为什么不能就地覆盖**：`rsync` 进 `/srv/yos-dist/` 或逐文件 `cp`，
中间有一段时间货架是半新半旧的。客户正好在那几秒取货，
`index.json` 说的和实际文件对不上，装机会以一个说不清的错误失败。

**真正原子的做法是换符号链接**（`rename(2)` 覆盖符号链接是原子的，
内核保证没有中间态）：

```bash
NEW=/srv/yos-dist.<新版本>-$(date +%Y%m%d-%H%M)

# 一次性改造（只做一次）：把 /srv/yos-dist 从真目录变成符号链接
mv /srv/yos-dist /srv/yos-dist.<当前版本>-init
ln -s /srv/yos-dist.<当前版本>-init /srv/yos-dist

# 以后每次切换：先建新目录，再原子换指向
cp -a <构建目录> $NEW
ln -sfn $NEW /srv/yos-dist.staging     # 先做一个临时符号链接
mv -T /srv/yos-dist.staging /srv/yos-dist   # 原子替换，无中间态
readlink -f /srv/yos-dist               # 核验指向
```

⚠️ **上线这套之前必须先确认三件事**（都在货架机上，属于生产）：

1. **nginx 的 `disable_symlinks` 不能是 `on`** —— 是 `on` 的话
   符号链接会被拒，货架直接 403。
2. **`open_file_cache` 会让切换有延迟生效** —— 开着的话旧 fd 还在被复用，
   切完 `curl` 到的可能仍是旧内容。要么关掉，要么切完 `nginx -s reload`。
3. **`root`/`alias` 指的是 `/srv/yos-dist`（那个符号链接）本身**，
   不是它当时指向的真目录 —— 指到真目录的话换链接对 nginx 毫无影响。

> **本文件作者没有在货架机上执行过这套。** 上面三条是必须先核的前置条件，
> 不是已经核过的结论。第一次按这份文件切换时请逐条确认，
> 有出入就地改这份文件。旧的「整目录 `mv` 换入」做法仍可用，
> 只是它有上面说的那个窗口。

### 第 7 步 · 公网制品哈希复核（切换之后，从**外面**看）

前面第 4 步量的是本地构建产物，这一步必须**从公网取回来再量**，
证明客户实际拿到的就是验过的那份。**有脚本，不要手点：**

```bash
node scripts/verify-public-shelf.mjs \
  --base-url https://yoyooai.com/dist \
  --full \
  --expect-build-id <验收报告里的 buildId> \
  --expect-index-sha256 <第 4 步记下的 index.json 摘要> \
  --expect-versions yos=<x.y.z>,feishu=<x.y.z>,weixin=<x.y.z>
```

它按公网 `index.json` **把每个登记文件都下下来逐个核 sha256 和字节数**，
外加这些结构检查（任何一项不过就 exit 1，**没有部分通过**）：

| 检查 | 卡住的是什么 |
|---|---|
| `publicationMode` = `production` | 把隔离验收用的货架切上了生产 |
| `droppedTags` 为空 | 公开过的钉版本地址变 404 |
| provider 非空、buildId 与 `index.json` 一致 | 空能力目录 / 两个文件来自不同次构建 |
| **清单自审**：每个镜像标签的归档、每个打好的包、每个已发布安装器、每条 vendor 来源，**都必须在 `files` 里登记** | **文件在架但从清单里漏登记** —— 逐个核哈希核不出这种错，因为它只核"清单里有的" |
| **`--expect-index-sha256`** | 清单本身被换掉（见下） |
| **核心版本 = 镜像标签集里最新的那个**，且与 `releases/latest.json` 一致 | 货架上有比本轮更新的版本却当成本轮通过 |
| 组件版本 = 能力目录里的 provider 版本，且其标签**确实被镜像、且是该条线最新** | 目录与货架各说一套 |

> **后三项是 2026-08-11 复核补上的，补之前那两条是真的假绿**（都实测过）：
> ①把一个包从 `index.json` 里删掉、文件照样在架 ⇒ 旧版脚本 **PASS**；
> ②让货架最新变成 `0.1.15`、历史表里仍列着 `0.1.14`、要求验 `0.1.14`
> ⇒ 旧版脚本 **PASS**（它当时只判断 `VERSIONS.md` 里**出现过**这个版本号，
> 历史表那一行就够骗过它）。现在版本一律**从标签集算**，不从文字里读。

**清单自己的完整性**：`index.json` 无法登记自己的哈希（真实货架的 `files` 里
确实没有它这一条），而 **`buildId` 不覆盖清单内容** —— 删掉几条登记，
buildId 一字不变。所以必须**两个参数一起给**：`--expect-build-id` 卡"是哪次构建"，
`--expect-index-sha256` 卡"清单一个字节没动过"。**两个都别省。**

**网络参数**（`--timeout-ms` 默认 60000、`--retries` 默认 2）：单文件超时 +
有限重试。加它的原因是实测踩过 —— 没有超时的 `fetch` 遇到一次抖动就**整跑挂死
90 秒以上不退出，只能手杀**。重试只覆盖传输层（超时/连接断/5xx）；
**4xx 不重试**，404 重试十次还是 404，只会让报告更晚到。

实测（2026-08-11 对当时的生产货架跑过）：**923/923 全部命中，约 34 秒**。
放行必须用 `--full`；`--sample` 只是平时抽查，输出里会自己说明
「不构成整架证明」。

**对不上就走第 8 步，不要留着「先这样」。**

### 第 8 步 · 失败回退

第 6、7 步任何一项对不上，立刻回退，不要在线上边修边试：

```bash
# 符号链接布局（第 6 步改造之后）：把指向换回旧目录，同样是原子的
ln -sfn /srv/yos-dist.bak-<旧版本>-<STAMP> /srv/yos-dist.staging
mv -T /srv/yos-dist.staging /srv/yos-dist
readlink -f /srv/yos-dist

# 真目录布局（还没改造）：整目录换回，失败的那份改名留着
mv /srv/yos-dist /srv/yos-dist.failed-$(date +%Y%m%d-%H%M)
mv /srv/yos-dist.bak-<旧版本>-<STAMP> /srv/yos-dist

# 回退后必须重跑第 7 步，拿旧版本号去卡
node scripts/verify-public-shelf.mjs --full \
  --expect-versions yos=<旧版本>,feishu=<旧版本>,weixin=<旧版本>
```

- **回退不是把命令跑完就算完，是第 7 步对旧版本重新过一遍才算完。**
  没重验的回退，等于把"现在线上是什么"这个问题又变成了猜。
- 失败的那份**留着别删**（改名到 `.failed-*`），它是查原因的现场。
- 本地副本也用不了的情况下，用第 5 步的站外备份恢复 ——
  恢复完先跑 `--local` 核一遍再换入，别把一份坏包换上线。

### 第 9 步 · 客户式终验（这一步不能用 HTTP 探活代替）

**`install.sh` 返回 200 不等于装得上。** 必须在一台干净机器上走完整客户路径：

```bash
curl -fsSL https://yoyooai.com/install.sh | bash -s -- -y
yos --version                                  # 应等于本次发布的 OS 版本
pm2 list                                       # 四个服务 online、restarts=0
yos add feishu && yos add weixin               # 版本号应等于货架上各自的当前版本
yos capability list                            # 能力目录客户端本地能列出各渠道
```

最后一条最容易被漏：能力目录**发布了**和客户端**认得**是两件事，要分别验。

> ⚠️ 干净机器上非交互 ssh 不会 source `.bashrc`，
> 直接跑 `yos` 会报 command not found。用 `bash -lic "yos ..."`。
> 这是测试方法的坑，不是装机失败 —— 别误判。

---

## 三、这份文件的证据来源

- **第 1 步（ff-only）与第 2 步（只给变化的组件打标签）**：苏白 2026-08-11 定的
  发布口径。第 2 步「没变的组件不会掉出货架」这句，依据是
  `capability-index.mjs` 的 `newestReleaseTag()` 从镜像标签集里挑最新版本 ——
  已读码确认。
- **两条硬性质（标签→能力目录、`main` 指向→buildId）**：出自 105 / 109 号验收。
- **第 3 步的参数**：`--production` / `--tags` / `--base-url` / `--vendor-cache`
  等均已在 `scripts/build-dist.mjs` 的 `parseArgs()` 里逐个核对存在。
- **第 7 步**：`scripts/verify-public-shelf.mjs` 是随这份文件一起加的，
  2026-08-11 对当时的生产货架**实跑过 `--full`，923/923 命中**；
  它自己的失败路径由 `test/verify-public-shelf.test.js` 用本地假货架
  逐条钉住（**24 条**：篡改、截断、空能力目录、掉标签、非 production、
  buildId 不符、组件版本不符、取不到、恢复副本完好/损坏，
  加复核后补的 包/归档/always 文件/vendor 来源**漏登记**四条、
  清单摘要不符与相符各一条、**货架有更新版本**、组件标签未镜像、
  组件被更新标签盖住、超时不挂死、5xx 重试后通过、4xx 不重试），
  **该红的每条都必须 exit 1**。
  第一版的三条假绿（漏登记、版本认字面、无超时）是**先用这组测试打红旧版脚本
  复现出来的**（旧版 12 条红、新版 24 条全绿），不是照着改法反推的测试。
- **第 5 步的符号链接坑**：2026-08-11 在本地同构布局上**实测过**
  （`/srv/yos-dist` 造成链接 → `cp -a` 得到的是链接 → tar 里只有一条
  绝对路径链接 → 目标路径挪走后解包内容为空，122 字节）。
  结论确定；**在货架机上没有执行过**（见下）。
- **第 9 步**：2026-08-11 在干净机上实测走通（0.1.14 / 飞书 0.1.4 / 微信 0.1.3，
  四服务 online，`yos capability list` 认出两个渠道）。
- **第 1~2 步的核指向命令**：本地实测过（`ls-remote` 的
  `refs/tags/...^{}` 解引用行为、push 后远端指向核对）。
- **第 5~6、8 步在货架机上的部分（打包/推备份机/符号链接切换/回退）
  不是本文件作者亲手执行的** —— 货架机属于生产，未获授权不碰。
  命令形态出自 0.1.4~0.1.14 各次实际上架记录与 `rename(2)` 的语义，
  第 6 步那三条 nginx 前置条件**是待核项不是结论**。
  首次按本文件发版时请逐条确认，有出入就地改这份文件。
