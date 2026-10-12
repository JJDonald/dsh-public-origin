# dsh-public-origin

让 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的第三方插件在「公网域名 + 反向代理」部署下正常工作。

DSH Web 部署在 VPS 上、通过 `https://your.domain` 访问时，一些插件会失效：设置页的 iframe 指向 `127.0.0.1` 被浏览器拒绝，管理操作报错，诊断接口返回 403。这些现象的原因相同：插件假定浏览器从回环地址访问 GUI，有的检查 Origin 是否为 `127.0.0.1:<port>`，有的检查 Host 是否为回环地址或 IP。换成公网域名并经过反代后，这两种检查都会失败。

本插件统一处理这类问题，不修改任何第三方插件的文件。

## 处理的情况

| 插件 | 现象 | 原因 | 处理 |
|---|---|---|---|
| [billion-context](https://www.npmjs.com/package/billion-context)（bili） | 设置页 iframe 打开 `127.0.0.1` 被拒绝 | `/bili/origin` 返回 `http://127.0.0.1:18787`，浏览器去访问用户自己的电脑 | 公网请求改为返回当前页面的 origin，并在 `/__bili/*` 下同源反代 bili 管理端口 |
| billion-context | 改配置、更新、清理等管理操作报错 | bili 管理 API 只接受回环 Origin/Host | 反代时去掉 Origin、Referer、Cookie 和 X-Forwarded-*，以回环身份访问 |
| [dsh-better-reasoning-effort](https://www.npmjs.com/package/dsh-better-reasoning-effort) | 诊断和配置路由返回 403 | 只接受回环地址或 IP 形式的 Host | 请求通过 DSH 门禁后，改写为回环 Host 再交给原 handler |
| [@linxin666/dsh-client-ui-skill-explorer](https://www.npmjs.com/package/@linxin666/dsh-client-ui-skill-explorer) | 接口返回 403 | 同上 | 同上 |

[dshmarket](https://www.npmjs.com/package/dshmarket) 已经接入 DSH 自身的请求门禁，不需要处理。

## 安全边界

插件先判断请求是**本机直连**还是**经过反向代理**：

- **本机直连**：socket 对端地址属于 127/8 或 `::1`，并且请求不带任何 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Real-IP` / `Forwarded` 头。这类请求原样交给原插件，由它自己的规则决定，行为和没装本插件时完全一样。
- **其他请求**：先经过 DSH 自身的 `connection.requestRejection`，也就是 `/api` 使用的同一套检查：
  - `--trusted-host` 白名单
  - 跨站请求标记（`Sec-Fetch-Site`）和 Origin 同源校验
  - DSH 签名的浏览器登录 Cookie

  未登录返回 401，Host 或 Origin 不可信返回 403。只有通过检查的请求才会被改写为回环身份。

判断时不看 `Host`。`Host` 由客户端控制，不能作为「来自本机」的依据。

附带效果：bili 原本未登录也能读取的 `/bili/origin`，在公网访问时也要求先登录。

bili 代理请求连续 **5 分钟没有网络活动**时会中止；这是空闲超时，不是总执行时限。bili 在响应中途断开时，下游连接会关闭，不会一直挂起或将截断响应当作完整成功；浏览器断开时也会取消上游连接。更新等有副作用的操作不会自动重试，遇到连接中断应先确认操作实际结果。

### v0.2.1 修复的认证绕过

v0.1.0 用 `Host` 是否为回环地址来决定是否跳过登录检查。如果反向代理原样转发客户端的 `Host`（例如 nginx 的 `proxy_set_header Host $host`），公网访问者只要发送 `Host: 127.0.0.1`，就能不登录直接：

- 读写 `/api/dsh-skill-explorer/*`（可以创建技能文件，内容会进入模型上下文）
- 读取 `/dsh-better-reasoning-effort/headers-config` 等诊断数据
- 从 `/bili/origin` 读到 bili 的回环地址

**使用 v0.1.0 的部署请升级到 v0.2.1 或更高版本。**

v0.1.0 只认回环 `Host` 还带来一个副作用：本机用 IP 地址访问时，reasoning-effort 的路由从 200 变成了 403。这个问题在 v0.2.1 中也一并恢复。

## 前提

- DSH 以 `--trusted-host <你的域名>` 启动，这也是 DSH 本身在反代后正常工作的前提。
- DSH 只监听回环地址（如 `--host 127.0.0.1`），公网只能经反向代理访问。
- **反向代理必须设置转发头**，至少设置 `X-Forwarded-For` 或 `X-Real-IP` 中的一个，并设置 `X-Forwarded-Proto`。插件靠这些头识别经过反代的请求。nginx 不会自动添加它们；如果都没设置，公网请求会被当作本机直连而跳过本插件的登录检查；若代理还转发客户端可控的 Host，下游插件可能发生认证绕过。不能把省略转发头仅视为功能失效。`X-Forwarded-Proto` 还用来生成 bili 页面的 `https://` 地址。
- 建议把 `Host` 固定为公网域名（`$server_name`），不要原样转发客户端的 `Host`（`$host`），作为纵深防御。

nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $server_name;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
}
```

`$server_name` 在这个 server 块中就是公网域名，和浏览器发出的 `Host` 相同，所以 DSH 登录 Cookie 绑定的地址不变，已有登录不受影响。前提是 server 块里只有一个 `server_name`，且它就是浏览器访问的域名。

## 安装

```sh
dsh plugin --profile web add github:JJDonald/dsh-public-origin
```

或者克隆后从本地路径安装：

```sh
git clone https://github.com/JJDonald/dsh-public-origin.git
cd dsh-public-origin
dsh plugin --profile web add "file:$(pwd)"
```

安装后重启 DSH Web 实例。代码在 `lib/` 中，无需构建。

## 配置

可以在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: public-origin
  config:
    localize:
      - /dsh-better-reasoning-effort
      - /api/dsh-skill-explorer
```

`localize` 是需要处理的「只认回环 Host」的路由前缀列表，上面是默认值。以后遇到同类插件，把它的路由前缀加进来即可。bili 的处理是固定启用的，不受这个列表影响。

## 卸载

```sh
dsh plugin --profile web remove dsh-public-origin
```

然后重启 DSH Web。

## 兼容性

- 当前版本 **0.2.1**。在 DSH **0.2.0-rc.2** 上部署使用，搭配 billion-context 0.1.192/0.1.194、dsh-better-reasoning-effort 0.5.2、dsh-client-ui-skill-explorer 0.4.6。
- Node.js **≥22**。
- 插件依赖 DSH 内部的 `webServer.match` 和 `connection.requestRejection`，以及 bili 的 `/bili/origin` 路由。上游改动这些接口后可能需要适配。
- 非官方插件。

## 许可

MIT
