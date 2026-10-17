# TG Scout

[中文](README.md) · [English](README.en.md)

**自托管的 Telegram 消息筛选与分析助手，跑在 Cloudflare Worker 上。**
用你自己的账号只读监听指定会话，按关键字或 AI 提示词挑出你关心的消息，也可以手动对某个会话做一次分析（翻译、总结等）。结果推送到「已保存消息」或在网页里查看。

> ⚠️ 这是个人自用工具，使用自动化程序登录用户号存在被 Telegram 限制或封禁的风险，请先阅读下方[风险与免责声明](#风险与免责声明)。

## 功能

- **两类筛选策略**
  - **关键字匹配**：任一命中 / 全部命中 / 正则，可配执行频率。
  - **AI 分析匹配**：写一段提示词，AI 判断哪些新消息符合；可配执行频率，也可设为**手动**，对所选会话最近 N 条消息做一次性分析（比如“翻译成中文”“总结要点”）。
- **只读**：不发言、不回复，只在命中时把结果推送出去。
- **多种推送渠道**：Telegram 会话、Telegram 机器人、邮件、Webhook（飞书 / 钉钉 / 企业微信 / Discord / Slack / 通用 JSON）、Bark、Server酱、ntfy；每个策略单独选推送到哪些渠道。
- **结果管理**：命中和任务结果以记录列表保存，可搜索，点开看全文，可复制、删除；按天数自动清理。
- **AI 用量统计**：今日 / 累计的输入、输出、总 token，每条结果也带自己的消耗。
- **出口代理**：支持 SOCKS5，并带一键测试（显示出口 IP、地区、连 Telegram 的耗时）。
- **登录保护**：错误次数限制、可选两步验证（TOTP）、可选邮箱找回密码。
- **失败可见**：每个策略显示最近一次运行状态和失败原因；配了邮箱时，连续失败会发邮件提醒。
- **无服务器**：Cloudflare Worker + D1，没有常驻进程，数据都在你自己的账号里。

## 工作原理

```
Cloudflare Cron（每分钟）─▶ Worker ─▶ MTProto（gramjs，经 cloudflare:sockets，可选 SOCKS5 代理）─▶ Telegram
                              │
                              ├─▶ 关键字 / AI（OpenAI 兼容接口）判断
                              ├─▶ D1：策略、记录、会话凭据、用量
                              └─▶ 命中结果推送到「已保存消息」或你指定的会话
```

- 每个策略为每个会话记一个“上次处理到的位置”，每次只处理**新消息**。
- 第一次运行只记录位置，不会处理历史消息；修改策略并保存后位置会重置。

## 准备

| 需要 | 说明 |
| --- | --- |
| Cloudflare 账号 | 免费账号即可开始，见[费用与限制](#费用与限制) |
| GitHub 账号 | 仅网页一键部署需要 |
| Node.js 18+（推荐 22） | 仅命令行部署需要，网页一键部署不需要 |
| Telegram `api_id` / `api_hash` | 在 <https://my.telegram.org/apps> 创建 |
| AI 接口 | 任意 OpenAI 兼容服务，例如 DeepSeek |
| 固定出口的 SOCKS5 代理（强烈建议） | 见[出口代理](#出口代理) |
| Resend 账号（可选） | 用于邮箱找回密码和失败告警 |

## 部署

### 方式一：网页一键部署（推荐，全程在浏览器里点）

不需要装 Node，也不用敲命令。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chhbzhou/tg-scout)

1. 点上面的 **Deploy to Cloudflare** 按钮，登录你的 Cloudflare 账号（没有就先注册）。
2. 按提示连接你的 **GitHub 账号**并授权。Cloudflare 会把本项目复制一份到你自己的 GitHub 仓库。
3. 在设置页确认项目名，**ADMIN_TOKEN** 一栏填你的登录密码：一个足够长的随机字符串，不要留默认值（默认值无法登录）。数据库不用管，会自动创建。
4. 点 **Create and deploy**，等部署完成，页面会给出你的访问地址（形如 `https://tg-scout.<你的子域>.workers.dev`）。
5. 打开地址，用第 3 步的密码登录，之后按下面的[配置](#配置)填写即可。

以后在你自己的 GitHub 仓库里改代码并推送，Cloudflare 会自动重新部署。

**绑定自己的域名**（`workers.dev` 在部分网络下打不开时需要）：Cloudflare 控制台 → Workers & Pages → 选你的 Worker → Settings → Domains & Routes → Add → Custom domain，填一个托管在 Cloudflare 的域名或子域名。

**查看和管理数据库**：控制台 → Storage & Databases → D1，默认名字是 `tg-scout-db`，里面有 Console 可以直接执行 SQL。

### 方式二：命令行部署

适合习惯命令行或想改代码的人。需要 Node.js 18+（推荐 22）。

1. **获取代码并安装依赖**

   ```bash
   git clone https://github.com/chhbzhou/tg-scout.git
   cd tg-scout
   npm install
   ```

2. **登录 Cloudflare**

   ```bash
   npx wrangler login
   ```

   或者用 API Token（适合在服务器上部署），设置环境变量 `CLOUDFLARE_API_TOKEN`，令牌需要：
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - 如果要绑定自己的域名，再加：Zone → Zone → Read、Zone → Workers Routes → Edit

3. **部署**

   ```bash
   npx wrangler deploy
   ```

   第一次部署会自动创建 D1 数据库（名字为 `tg-scout-db`），表结构在第一次请求时自动建好。输出的地址就是你的控制台。

4. **设置登录密码**

   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```

   输入一个足够长的随机字符串，这是你第一次登录用的密码，登录后可以在页面里改成自己的。没设置之前无法登录。

5. **（可选）绑定自己的域名**：取消 `wrangler.toml` 里 `[[routes]]` 的注释，改成你的域名，再执行一次 `npx wrangler deploy`。绑定自定义域名后，默认的 `workers.dev` 地址会被关闭，想保留的话加一行 `workers_dev = true`。

### 本地调试

```bash
cp .dev.vars.example .dev.vars   # 里面写一个本地用的 ADMIN_TOKEN
npm run dev                       # http://localhost:8787，D1 使用本地模拟
```

## 配置

进入「设置」页，改完后点右上角「保存」（有未保存的修改时按钮会变成蓝色）。

### Telegram

1. 打开 <https://my.telegram.org/apps>（设置页 Telegram 卡片右上角也有链接），用手机号登录后创建应用：
   - App title：至少 5 个字符，不能包含 “Telegram”，例如 `Message Scout`
   - Short name：5–32 位字母数字，例如 `msgscout`
   - URL 留空，Platform 选 Desktop，Description 随便写一句
   - 创建后得到 `api_id` 和 `api_hash`，填进设置页。**不要把它们发给任何人。**
2. 填好并保存**出口代理**（见下），先点「测试」确认能通。
3. 在「账号」卡片填区号和手机号，点「发送验证码」，验证码会发到你已登录的 Telegram 官方对话里（不是短信），填入后点「登录」。开了二步验证的，还要填二步密码。
4. 登录成功后，你的 Telegram「设备」列表里会多一个名为 Desktop 的会话，可随时在那里终止。

### 出口代理

格式 `socks5://用户:密码@主机:端口`，没有认证就写 `socks5://主机:端口`。密码里有 `@ : /` 等特殊字符要做 URL 编码。

**为什么建议配固定出口的代理**：不配的话，Telegram 看到的登录 IP 是 Cloudflare 的动态数据中心 IP，同一个账号的 IP 频繁变化容易触发风控、掉线甚至被限制。代理必须能从公网访问到，因为连接是 Cloudflare 的机器发起的，不是你的电脑。

输入框右侧的「测试」会通过该代理访问一次 ip-api.com 查出口 IP 和地区，再连一次 Telegram 服务器并显示耗时。

### 推送渠道

设置页「推送渠道」卡片管理所有渠道；在每个策略里勾选「推送到」哪些渠道，一个都不勾就只记录、不推送。某个渠道推送失败不影响其他渠道，失败原因会显示在策略卡片上。

**内置渠道**

- **Telegram 会话**：用你登录的账号发。目标在 Telegram 卡片的「推送到」里选：已保存消息，或自定义 `@频道名` / 会话 ID（建议建一个只有自己的私有频道）。
- **邮件**：复用「邮箱找回」里配置的 Resend Key 和收件邮箱，配好才可用。

**自定义渠道**（点「添加渠道」，每个都有「测试」按钮，真的会发一条测试消息）

| 类型 | 需要填 | 怎么获取 |
| --- | --- | --- |
| Telegram 机器人 | Bot Token、Chat ID | 在 Telegram 里找 @BotFather 创建机器人拿 Token；先给机器人发一条消息，Chat ID 填你的数字 ID 或频道 `@名称`（频道需把机器人加为管理员） |
| Webhook | 格式、地址，飞书 / 钉钉可选签名密钥 | 飞书：群设置 → 机器人 → 自定义机器人；钉钉：群设置 → 智能群助手 → 自定义机器人；企业微信：群 → 添加群机器人；Discord：频道设置 → 集成 → Webhook；Slack：Incoming Webhooks。机器人如果开启了「加签」，把密钥填到签名密钥；钉钉的「自定义关键词」安全设置要求消息里包含该关键词 |
| Bark | Key，服务地址可选 | iOS 上安装 Bark，复制 App 里的 Key；自建服务器时填服务地址 |
| Server酱 | SendKey | [Server酱 Turbo](https://sct.ftqq.com/) 获取，推送到微信 |
| ntfy | 主题，服务地址和 Token 可选 | 手机装 ntfy 订阅一个主题；公共服务器是 ntfy.sh，也可自建 |

「通用 JSON」格式会 POST `{title, text, link, strategy, chat, reason, ts}`，可以接你自己的服务。

各第三方服务的额度和收费以官方为准：ntfy 的公共服务器官方说明是免费使用但有限速，Bark 是开源可自建的，Server酱 的免费额度很有限。地址、Key 这类敏感字段保存后只显示末尾几位。

### AI

任意 OpenAI 兼容接口，需要提供 `/chat/completions`。

| 项 | 示例（DeepSeek） |
| --- | --- |
| 接口地址 | `https://api.deepseek.com/v1` |
| 模型 | `deepseek-chat` |
| 密钥 | 在服务商后台创建 |

- 点「测试」会真的发一条 `hello` 并显示回复和耗时。
- 不要选推理类模型：它们会先输出一大段思考，更慢更贵，而且程序要求只返回 JSON，容易解析失败。
- 产生过消耗后，卡片下方会出现今日 / 累计 token 表，右侧「重新计数」可清零。

### 记录保留天数

命中记录和任务结果保留多少天，默认 30，填 0 不清理。每小时整点自动清理一次，不影响策略本身和用量统计。

## 使用策略

在「策略」页点「新增策略」。

### 关键字匹配

- 关键字输入后回车添加。匹配方式：任一命中、全部命中、正则（不区分大小写）。
- 频率：1–1440 分钟，不在范围内保存时会报错。

### AI 分析匹配

- 提示词写你的筛选标准，比如“找出在招聘 Go 后端的消息”。
- **运行方式**：
  - **定时**：按频率处理新消息，命中的推送并记录。
  - **手动**：不自动运行，点卡片上的「运行」才执行。读取每个所选会话的最近 N 条（默认 50，最多 200），按提示词整体处理，结果在面板里显示并存入记录，可勾选是否同时推送。手动运行必须选会话。

### 处理细节（影响额度和费用）

- 定时处理时，新消息每 30 条为一批发给 AI，只返回命中的；单条消息只取前 1200 字；每个会话每轮最多取 100 条新消息，积压的下一轮继续。
- 手动运行总文本超过约 6 万字时，保留最近的部分。
- 没有文字的消息（图片、文件等）会被跳过。
- 会话选“全部”时，每轮会逐个检查所有会话，更慢也更耗额度，建议只选需要的。
- 消息文本会发送给你配置的 AI 服务，涉及敏感内容的会话请留意。

## 安全

- **登录**：登录后发放有效期 30 天的会话令牌；同一 IP 15 分钟内输错 5 次，或所有来源累计输错 20 次，会锁定 15 分钟。改密码或开启两步验证后，其他设备会被退出。
- **两步验证（TOTP）**：设置页「两步验证」里扫码绑定，输入一次动态码确认后开启；关闭也需要动态码。
- **邮箱找回**（可选）：在设置页填入 [Resend](https://resend.com/api-keys) API Key 和收件邮箱，保存后登录页才会出现「忘记密码」。验证码 6 位、10 分钟有效、60 秒内只能发一次、输错 5 次作废。**找回成功会同时关闭两步验证。**
  - 没有验证域名时，Resend 的发件人 `onboarding@resend.dev` 只能发给注册 Resend 的那个邮箱。要发给其他邮箱，需要在 Resend 验证自己的域名，并在「发件人」填 `名称 <noreply@你的域名>`。
- **失败告警**：每个策略都会显示最近一次运行状态；配了邮箱后，定时策略连续失败 3 次会发一封汇总邮件，两封之间至少隔 1 小时。
  - 失败通知不走 Telegram，因为代理或会话出问题时 Telegram 本身就发不出去。
- **数据**：Telegram 会话凭据、api_hash、AI 密钥、Resend Key 都明文存放在你自己的 D1 里。拿到 D1 或登录态就等于拿到你的账号，请用强密码、开两步验证，建议再用 Cloudflare Access 给控制台加一层。

## 费用与限制

Cloudflare 官方限制（[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)，以官方页面为准）：

| 项目 | Workers Free | Workers Paid |
| --- | --- | --- |
| 每次 HTTP 请求的 CPU 时间 | 10 ms | 默认 30 秒 |
| 每次 Cron 触发的 CPU 时间 | **10 ms** | 30 秒（间隔小于 1 小时） |
| Cron 触发的墙钟时间 | 15 分钟 | 15 分钟 |
| 每次调用的子请求数 | **50** | 10,000 |
| 每个账号的 Cron 触发器数 | 5（本项目用 1 个） | 250 |
| 每日请求数 | 100,000（本项目每天定时唤醒约 1,440 次） | 不限 |

实测（作者的部署）：

- 普通 API 请求的 CPU 约 **1 ms**。
- 没有策略到期时，每分钟的定时唤醒 CPU 约 **5–7 ms**，已经接近免费版的 10 ms 上限。
- 定时唤醒里真正去 Telegram 拉取消息（建立连接、解密、调 AI）的 CPU 占用**没有系统实测**，可能超过 10 ms。超限时该次调用会被终止，策略会显示失败；这种情况需要升级 **Workers Paid（约 5 美元/月）**。
- 子请求：每次 AI 调用、邮件发送都算一次。免费版每次调用最多 50 个，积压大量消息时可能处理不完，下一轮会从上次的位置继续。

其他：

- 定时任务最小粒度 1 分钟，时区为 UTC；新增或修改触发器后最多 15 分钟全球生效。
- AI 费用由你的 AI 服务商收取。
- D1 有免费额度，个人使用基本用不完。

## 风险与免责声明

- **账号风险**：用程序登录用户号不属于 Telegram 官方客户端，可能违反其服务条款，账号有被限制、冻结或封禁的可能。本项目只读、不主动发送（仅向推送目标发通知）能降低风险，但不能消除。请使用你愿意承担风险的账号，作者不对任何后果负责。
- **合规**：请遵守 Telegram 的条款和所在地法律。本项目只面向个人处理自己能看到的消息，**不得**用于骚扰、群发、批量采集他人信息或其他违法用途。
- **数据外发**：AI 策略会把消息文本发给你配置的 AI 服务；命中的消息会发给你选择的推送渠道（包括第三方的飞书、钉钉、Server酱、Bark 等）；代理测试会访问第三方 ip-api.com。
- **提示注入**：消息内容是不可信输入，系统提示已要求 AI 只做判断、不执行消息里的指令，但仍可能被诱导误判，结果仅供参考。
- 软件按“现状”提供，不提供任何担保，详见 [LICENSE](LICENSE)。

## 常见问题

**打开页面显示无法访问 / 连接被重置**
`workers.dev` 域名在部分网络下被干扰。绑定你自己托管在 Cloudflare 的域名（见部署第 6 步）。

**发了验证码但没收到**
验证码来自 Telegram 官方对话，不是短信。先确认 api_id / api_hash 正确、代理测试能通；如果频繁请求，Telegram 会暂时限制，等一会儿再试。

**登录后过一阵掉线 / 提示未登录**
Telegram 可能终止了这个会话（IP 变化、风控等）。重新登录即可，并检查是否配了固定出口代理。

**策略一直显示失败**
卡片上的红字就是原因。常见：代理失效、会话被终止、AI 地址或密钥错误、AI 未配置。先用设置页的两个「测试」按钮排查。

**忘记密码**
- 配了邮箱：登录页点「忘记密码」。
- 没配邮箱：清掉库里的密码和两步验证记录，之后用部署时设置的 `ADMIN_TOKEN` 登录。网页方式：控制台 → D1 → `tg-scout-db` → Console，执行下面的 SQL；命令行方式：

  ```sql
  DELETE FROM settings WHERE k IN ('pw_hash','pw_salt','totp_on','totp_secret');
  DELETE FROM sessions;
  ```

  ```bash
  npx wrangler d1 execute tg-scout-db --remote --command \
    "DELETE FROM settings WHERE k IN ('pw_hash','pw_salt','totp_on','totp_secret'); DELETE FROM sessions;"
  ```

**测试邮件提示只能发给注册邮箱**
见上文“邮箱找回”，改用注册 Resend 的邮箱，或验证自己的域名。

**想换 Telegram 账号**
设置页「账号」卡片点「退出账号」后重新登录。

## 目录结构

```
src/
  index.js     路由与 API
  auth.js      登录、会话、限流、TOTP、邮件
  tg.js        Telegram 客户端、登录、会话列表
  sockets.js   Worker 套接字适配层、SOCKS5、代理测试
  run.js       定时执行、手动任务、失败告警
  match.js     关键字匹配、AI 调用
  notify.js    推送渠道（Telegram 机器人、Webhook、Bark、Server酱、ntfy）
  db.js        D1 表结构与数据访问
  page.html    控制台页面
```

## 参与贡献

欢迎提 Issue 和 PR。提交前请确认没有带入密钥、域名、数据库 ID 等个人信息。

## 许可证

[MIT](LICENSE)
