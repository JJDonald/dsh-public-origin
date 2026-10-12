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

所有非回环请求先经过 DSH 自身的 `connection.requestRejection`，也就是 `/api` 使用的同一套检查：

- `--trusted-host` 白名单
- 跨站请求标记（`Sec-Fetch-Site`）和 Origin 同源校验
- DSH 签名的浏览器登录 Cookie

未登录返回 401，Host 或 Origin 不可信返回 403。只有通过检查的请求才会被改写为回环身份。从回环地址发来的请求不做任何改动，本机访问的行为与安装前相同。

这样做还有一个附带效果：bili 原本未登录也能读取的 `/bili/origin`，在公网访问时也要求先登录。

## 前提

- DSH 以 `--trusted-host <你的域名>` 启动，这也是 DSH 本身在反代后正常工作的前提。
- 反向代理原样传递 `Host`，并设置 `X-Forwarded-Proto`。nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
}
```

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

- 在 DSH **0.2.0-rc.2** 上部署使用，搭配 billion-context 0.1.192/0.1.194、dsh-better-reasoning-effort 0.5.2、dsh-client-ui-skill-explorer 0.4.6。
- Node.js **≥22**。
- 插件依赖 DSH 内部的 `webServer.match` 和 `connection.requestRejection`，以及 bili 的 `/bili/origin` 路由。上游改动这些接口后可能需要适配。
- 非官方插件。

## 许可

MIT
